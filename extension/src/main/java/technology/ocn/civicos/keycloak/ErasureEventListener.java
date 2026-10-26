package technology.ocn.civicos.keycloak;

import java.util.List;
import org.jboss.logging.Logger;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.events.admin.OperationType;
import org.keycloak.events.admin.ResourceType;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.representations.JsonWebToken;

/**
 * Account erasure: when an account is deleted (an administrator deletes the user, or the person
 * deletes their own account), tell every product that registered an erasure URL (client
 * attribute {@value #ATTRIBUTE}) with a signed {@code erasure_token}, so it can erase the person
 * its own way. The token is a realm-signed JWT like a back-channel logout token:
 * {@code { iss, aud: <client id>, sub, email, iat, exp, jti, events: { "https://ocn.technology/events/account-erased": {} } }}
 * ({@code email} is the account's address just before deletion, when known).
 *
 * The notices go into {@link ErasureOutbox} in the deletion's own transaction (Keycloak's
 * database, so a restart loses nothing), are sent straight after the commit and retried with
 * back-off for at least 24 hours.
 */
public class ErasureEventListener implements EventListenerProvider {
    public static final String ID = "civicos-erasure";
    public static final String ATTRIBUTE = "civicos.erasure.url";
    public static final String EVENT = "https://ocn.technology/events/account-erased";
    /** Session attribute prefix holding the email of a user about to be removed (set by the factory's pre-remove hook). */
    static final String EMAIL_NOTE = "civicos.erasure.email.";
    private static final Logger LOG = Logger.getLogger(ErasureEventListener.class);

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
        Object email = session.getAttribute(EMAIL_NOTE + userId);
        List<String> ids = ErasureOutbox.enqueue(session, realm, userId, email instanceof String s ? s : null, why, null);
        if (ids.isEmpty()) return;
        LOG.infof("CivicOS erasure: user %s (%s), notifying %d product(s)", userId, why, ids.size());
        var factory = session.getKeycloakSessionFactory();
        session.getTransactionManager().enlistAfterCompletion(new org.keycloak.models.AbstractKeycloakTransaction() {
            @Override protected void commitImpl() { ErasureOutbox.sendSoon(factory, ids); }
            @Override protected void rollbackImpl() { }
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
