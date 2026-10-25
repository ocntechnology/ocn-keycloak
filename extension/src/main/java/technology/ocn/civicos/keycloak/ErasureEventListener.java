package technology.ocn.civicos.keycloak;

import java.net.URI;
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
import java.util.concurrent.TimeUnit;
import org.jboss.logging.Logger;
import org.keycloak.common.util.Time;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.events.admin.OperationType;
import org.keycloak.events.admin.ResourceType;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.representations.JsonWebToken;

/**
 * Account erasure: when an account is deleted (an administrator deletes the user, or the person
 * deletes their own account), tell every product that registered an erasure URL (client
 * attribute {@value #ATTRIBUTE}) with a signed {@code erasure_token}, so it can erase the person
 * its own way. The token is a realm-signed JWT like a back-channel logout token:
 * {@code { iss, aud: <client id>, sub, iat, exp, jti, events: { "https://ocn.technology/events/account-erased": {} } }}.
 *
 * Calls go out after the deletion commits, each tried up to {@value #ATTEMPTS} times with a
 * back-off; failures are logged with the client and the person's id so they can be replayed
 * ({@code scripts/erasure/resend.mjs}, through {@link ErasureResource}).
 */
public class ErasureEventListener implements EventListenerProvider {
    public static final String ID = "civicos-erasure";
    public static final String ATTRIBUTE = "civicos.erasure.url";
    public static final String EVENT = "https://ocn.technology/events/account-erased";
    static final int ATTEMPTS = 4;
    private static final Logger LOG = Logger.getLogger(ErasureEventListener.class);
    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();

    private final KeycloakSession session;

    public ErasureEventListener(KeycloakSession session) {
        this.session = session;
    }

    /** The user id in an admin event's resource path ("users/<id>"), or null. */
    static String userIdFromPath(String resourcePath) {
        if (resourcePath == null) return null;
        String[] parts = resourcePath.split("/");
        return parts.length == 2 && "users".equals(parts[0]) && !parts[1].isBlank() ? parts[1] : null;
    }

    @Override
    public void onEvent(Event event) {
        if (event.getType() == EventType.DELETE_ACCOUNT && event.getUserId() != null) {
            schedule(session.realms().getRealm(event.getRealmId()), event.getUserId(), "account deleted by the person");
        }
    }

    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        if (event.getOperationType() != OperationType.DELETE || event.getResourceType() != ResourceType.USER) return;
        String userId = userIdFromPath(event.getResourcePath());
        if (userId != null) schedule(session.realms().getRealm(event.getRealmId()), userId, "account deleted by an administrator");
    }

    private void schedule(RealmModel realm, String userId, String why) {
        if (realm == null) return;
        List<String[]> calls = signed(session, realm, userId, why, null);
        if (calls.isEmpty()) return;
        LOG.infof("CivicOS erasure: user %s (%s), notifying %d product(s)", userId, why, calls.size());
        session.getTransactionManager().enlistAfterCompletion(new org.keycloak.models.AbstractKeycloakTransaction() {
            @Override protected void commitImpl() { for (String[] c : calls) send(c[0], c[1], c[2], userId); }
            @Override protected void rollbackImpl() { }
        });
    }

    /**
     * Signed erasure tokens for every client with an erasure URL (or just {@code onlyClientId}):
     * each entry is { clientId, url, token }.
     */
    static List<String[]> signed(KeycloakSession session, RealmModel realm, String userId, String why, String onlyClientId) {
        List<Map.Entry<String, String>> targets = new ArrayList<>();
        realm.getClientsStream().forEach((ClientModel c) -> {
            String url = c.getAttribute(ATTRIBUTE);
            if (url != null && !url.isBlank() && c.isEnabled() && (onlyClientId == null || onlyClientId.equals(c.getClientId()))) targets.add(Map.entry(c.getClientId(), url));
        });
        List<String[]> calls = new ArrayList<>();
        if (targets.isEmpty()) return calls;
        // Sign now, inside the request (the realm keys are available); send after the commit.
        String issuer = org.keycloak.services.Urls.realmIssuer(session.getContext().getUri().getBaseUri(), realm.getName());
        for (Map.Entry<String, String> t : targets) {
            JsonWebToken token = new ErasureToken();
            token.id(UUID.randomUUID().toString());
            token.issuer(issuer);
            token.audience(t.getKey());
            token.subject(userId);
            token.iat((long) Time.currentTime());
            token.exp((long) Time.currentTime() + 2L * 24 * 3600);
            token.setOtherClaims("events", Map.of(EVENT, Map.of()));
            token.setOtherClaims("reason", why);
            String signed = session.tokens().encode(token);
            calls.add(new String[] { t.getKey(), t.getValue(), signed });
        }
        return calls;
    }

    static void send(String clientId, String url, String token, String userId) {
        String body = "erasure_token=" + java.net.URLEncoder.encode(token, StandardCharsets.UTF_8);
        CompletableFuture.runAsync(() -> {
            long wait = 2;
            for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
                try {
                    HttpRequest req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(15))
                        .header("content-type", "application/x-www-form-urlencoded")
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build();
                    HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
                    if (res.statusCode() >= 200 && res.statusCode() < 300) {
                        LOG.infof("CivicOS erasure: %s erased user %s", clientId, userId);
                        return;
                    }
                    if (res.statusCode() == 400) {
                        LOG.errorf("CivicOS erasure: %s refused the token for user %s: %s", clientId, userId, res.body());
                        return;
                    }
                    LOG.warnf("CivicOS erasure: %s answered %d for user %s (attempt %d)", clientId, res.statusCode(), userId, attempt);
                } catch (Exception e) {
                    LOG.warnf("CivicOS erasure: %s unreachable for user %s (attempt %d): %s", clientId, userId, attempt, e.getMessage());
                }
                try { TimeUnit.SECONDS.sleep(wait); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return; }
                wait *= 4;
            }
            LOG.errorf("CivicOS erasure FAILED: %s did not erase user %s after %d attempts; resend with scripts/erasure/resend.mjs", clientId, userId, ATTEMPTS);
        });
    }

    /** Signed like an access token (the realm's RS256 key, published in its JWKS), not as an internal HMAC token. */
    static final class ErasureToken extends JsonWebToken {
        @Override
        public org.keycloak.TokenCategory getCategory() {
            return org.keycloak.TokenCategory.ACCESS;
        }
    }

    @Override
    public void close() { }
}
