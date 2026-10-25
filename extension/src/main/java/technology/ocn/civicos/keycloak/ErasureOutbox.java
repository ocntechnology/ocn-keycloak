package technology.ocn.civicos.keycloak;

import jakarta.persistence.EntityManager;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.jboss.logging.Logger;
import org.keycloak.common.util.Time;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.representations.JsonWebToken;

/**
 * The account-erasure outbox. Each product (client attribute {@value ErasureEventListener#ATTRIBUTE})
 * gets one row per erased account, written in the deletion's own transaction. The row is tried
 * straight after the commit, then by a timer every {@value #TICK_SECONDS} seconds with back-off
 * (realm attribute {@code civicos.erasure.retryBaseSeconds}, default 60: 1, 4, 16, 64 minutes,
 * then every {@value #MAX_WAIT_HOURS} hours) for {@value #GIVE_UP_HOURS} hours. It survives
 * restarts. A 2xx answer deletes the row; a 400 (the product refused the token) or running out of
 * time marks it failed and logs an ERROR line starting "CivicOS erasure FAILED", which is the
 * alert. Failed rows stay visible at {@code GET /realms/<realm>/civicos-erasure/pending} and can be
 * sent again with {@code scripts/erasure/resend.mjs}.
 */
public final class ErasureOutbox {
    static final long TICK_SECONDS = 15;
    static final long MAX_WAIT_HOURS = 4;
    static final long GIVE_UP_HOURS = 25;
    /** How long one attempt holds a row, so two Keycloak nodes do not send it at once. */
    static final long LEASE_SECONDS = 120;
    private static final Logger LOG = Logger.getLogger(ErasureOutbox.class);
    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();

    private ErasureOutbox() {}

    /** Seconds to wait after the {@code attempts}-th failed attempt: base, 4 x base, 16 x base, ... at most 4 hours. */
    static long backoff(long baseSeconds, int attempts) {
        long wait = baseSeconds;
        for (int i = 1; i < attempts && wait < MAX_WAIT_HOURS * 3600; i++) wait *= 4;
        return Math.min(wait, MAX_WAIT_HOURS * 3600);
    }

    /** Has a notice that has failed this often, first queued at {@code created}, run out of time? */
    static boolean givenUp(long created, long now) {
        return now - created > GIVE_UP_HOURS * 3600;
    }

    static EntityManager em(KeycloakSession s) {
        return s.getProvider(JpaConnectionProvider.class).getEntityManager();
    }

    /** Queue one notice per product (or only {@code onlyClientId}). Runs in the caller's transaction. */
    static List<String> enqueue(KeycloakSession session, RealmModel realm, String userId, String email, String why, String onlyClientId) {
        String issuer = org.keycloak.services.Urls.realmIssuer(session.getContext().getUri().getBaseUri(), realm.getName());
        long now = Time.currentTime();
        List<String> ids = new ArrayList<>();
        EntityManager em = em(session);
        realm.getClientsStream().forEach((ClientModel c) -> {
            String url = c.getAttribute(ErasureEventListener.ATTRIBUTE);
            if (url == null || url.isBlank() || !c.isEnabled() || (onlyClientId != null && !onlyClientId.equals(c.getClientId()))) return;
            ErasureOutboxEntity e = new ErasureOutboxEntity();
            e.setId(UUID.randomUUID().toString());
            e.setRealmId(realm.getId());
            e.setClientId(c.getClientId());
            e.setUrl(url);
            e.setUserId(userId);
            e.setEmail(email == null || email.isBlank() ? null : email.toLowerCase());
            e.setReason(why);
            e.setIssuer(issuer);
            e.setCreated(now);
            e.setNextAttempt(now);
            em.persist(e);
            ids.add(e.getId());
        });
        return ids;
    }

    /** Try these rows now, off the request thread (after the deletion has committed). */
    static void sendSoon(KeycloakSessionFactory factory, List<String> ids) {
        if (ids.isEmpty()) return;
        CompletableFuture.runAsync(() -> { for (String id : ids) attempt(factory, id); });
    }

    /** The timer: every row that is due. */
    static void sendDue(KeycloakSessionFactory factory) {
        List<String> due = KeycloakModelUtils.runJobInTransactionWithResult(factory, s ->
            em(s).createNamedQuery("civicosErasureDue", ErasureOutboxEntity.class).setParameter("now", (long) Time.currentTime())
                .setMaxResults(50).getResultList().stream().map(ErasureOutboxEntity::getId).toList());
        for (String id : due) attempt(factory, id);
    }

    private record Claim(String clientId, String url, String token, String userId) {}

    /** One attempt for one row: claim it, send without holding a transaction, record the answer. */
    static void attempt(KeycloakSessionFactory factory, String id) {
        Claim claim;
        try {
            claim = KeycloakModelUtils.runJobInTransactionWithResult(factory, s -> claim(s, id));
        } catch (RuntimeException e) {
            LOG.warnf(e, "CivicOS erasure: could not read pending notice %s", id);
            return;
        }
        if (claim == null) return;
        int status;
        String error;
        try {
            String body = "erasure_token=" + URLEncoder.encode(claim.token(), StandardCharsets.UTF_8);
            HttpRequest req = HttpRequest.newBuilder(URI.create(claim.url())).timeout(Duration.ofSeconds(15))
                .header("content-type", "application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            status = res.statusCode();
            String b = res.body() == null ? "" : res.body();
            error = "HTTP " + status + (b.isBlank() ? "" : ": " + b.substring(0, Math.min(200, b.length())));
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            status = -1;
            error = "unreachable: " + e.getMessage();
        }
        final int code = status;
        final String err = error;
        KeycloakModelUtils.runJobInTransaction(factory, s -> record(s, id, code, err));
    }

    static Claim claim(KeycloakSession s, String id) {
        EntityManager em = em(s);
        ErasureOutboxEntity e = em.find(ErasureOutboxEntity.class, id);
        long now = Time.currentTime();
        if (e == null || e.isFailed() || e.getNextAttempt() > now) return null;
        int n = em.createQuery("update ErasureOutboxEntity e set e.nextAttempt = :lease where e.id = :id and e.nextAttempt = :old")
            .setParameter("lease", now + LEASE_SECONDS).setParameter("id", id).setParameter("old", e.getNextAttempt()).executeUpdate();
        if (n != 1) return null; // another node has it
        RealmModel realm = s.realms().getRealm(e.getRealmId());
        if (realm == null) { em.remove(em.contains(e) ? e : em.merge(e)); return null; }
        s.getContext().setRealm(realm);
        return new Claim(e.getClientId(), e.getUrl(), sign(s, e.getIssuer(), e.getClientId(), e.getUserId(), e.getEmail(), e.getReason()), e.getUserId());
    }

    static void record(KeycloakSession s, String id, int status, String error) {
        EntityManager em = em(s);
        ErasureOutboxEntity e = em.find(ErasureOutboxEntity.class, id);
        if (e == null) return;
        long now = Time.currentTime();
        e.setAttempts(e.getAttempts() + 1);
        if (status >= 200 && status < 300) {
            LOG.infof("CivicOS erasure: %s erased user %s (attempt %d)", e.getClientId(), e.getUserId(), e.getAttempts());
            em.remove(e);
            return;
        }
        e.setLastError(error.length() > 1000 ? error.substring(0, 1000) : error);
        if (status == 400) {
            e.setFailed(true);
            LOG.errorf("CivicOS erasure FAILED: %s refused the notice for user %s (%s); fix the product, then resend with scripts/erasure/resend.mjs", e.getClientId(), e.getUserId(), error);
            return;
        }
        if (givenUp(e.getCreated(), now)) {
            e.setFailed(true);
            LOG.errorf("CivicOS erasure FAILED: %s did not erase user %s after %d attempts over %d hours (%s); resend with scripts/erasure/resend.mjs", e.getClientId(), e.getUserId(), e.getAttempts(), GIVE_UP_HOURS, error);
            return;
        }
        RealmModel realm = s.realms().getRealm(e.getRealmId());
        long wait = backoff(RealmSettings.erasureRetryBaseSeconds(realm), e.getAttempts());
        e.setNextAttempt(now + wait);
        LOG.warnf("CivicOS erasure: %s did not erase user %s (attempt %d, %s); next try in %d s", e.getClientId(), e.getUserId(), e.getAttempts(), error, wait);
    }

    /** A realm-signed JWT like a back-channel logout token (RS256, the realm's published key). */
    static String sign(KeycloakSession session, String issuer, String clientId, String userId, String email, String why) {
        JsonWebToken token = new ErasureEventListener.ErasureToken();
        token.id(UUID.randomUUID().toString());
        token.issuer(issuer);
        token.audience(clientId);
        token.subject(userId);
        token.iat((long) Time.currentTime());
        token.exp((long) Time.currentTime() + 2L * 24 * 3600);
        token.setOtherClaims("events", Map.of(ErasureEventListener.EVENT, Map.of()));
        if (email != null) token.setOtherClaims("email", email);
        if (why != null) token.setOtherClaims("reason", why);
        return session.tokens().encode(token);
    }

    /** Every notice not yet delivered in a realm (pending and failed), for the support endpoint. */
    static List<Map<String, Object>> list(KeycloakSession session, RealmModel realm) {
        return em(session).createNamedQuery("civicosErasureAll", ErasureOutboxEntity.class).setParameter("realmId", realm.getId()).getResultList().stream()
            .map(e -> Map.<String, Object>of(
                "id", e.getId(), "sub", e.getUserId(), "clientId", e.getClientId(), "attempts", e.getAttempts(),
                "status", e.isFailed() ? "failed" : "pending", "created", e.getCreated(), "nextAttempt", e.getNextAttempt(),
                "lastError", e.getLastError() == null ? "" : e.getLastError()))
            .toList();
    }
}
