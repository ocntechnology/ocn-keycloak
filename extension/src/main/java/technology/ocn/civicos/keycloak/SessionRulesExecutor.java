package technology.ocn.civicos.keycloak;

import java.util.List;
import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.OAuthErrorException;
import org.keycloak.common.util.Time;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.representations.RefreshToken;
import org.keycloak.representations.idm.ClientPolicyExecutorConfigurationRepresentation;
import org.keycloak.services.clientpolicy.ClientPolicyContext;
import org.keycloak.services.clientpolicy.ClientPolicyEvent;
import org.keycloak.services.clientpolicy.ClientPolicyException;
import org.keycloak.services.clientpolicy.context.TokenRefreshContext;
import org.keycloak.services.clientpolicy.executor.ClientPolicyExecutorProvider;
import org.keycloak.services.clientpolicy.executor.ClientPolicyExecutorProviderFactory;

/**
 * Client policy executor {@value #ID}: applies {@link SessionRules} at every token refresh, for
 * every client (realm client policy {@code civicos-session-rules}, condition {@code any-client}).
 * Products refresh every 5 minutes, so a council SSO session past 12 hours, a password session at
 * an organisation that now requires SSO, or a session whose mailbox check is past 30 days ends in
 * every product within minutes. A refused refresh also ends the Keycloak session, so the browser
 * cookie cannot be used to sign in again silently.
 */
public class SessionRulesExecutor implements ClientPolicyExecutorProvider<ClientPolicyExecutorConfigurationRepresentation> {
    public static final String ID = "civicos-session-rules";
    private static final Logger LOG = Logger.getLogger(SessionRulesExecutor.class);

    private final KeycloakSession session;

    public SessionRulesExecutor(KeycloakSession session) { this.session = session; }

    @Override public String getProviderId() { return ID; }

    @Override
    public void executeOnEvent(ClientPolicyContext context) throws ClientPolicyException {
        if (context.getEvent() != ClientPolicyEvent.TOKEN_REFRESH) return;
        String raw = ((TokenRefreshContext) context).getParams().getFirst("refresh_token");
        if (raw == null) return;
        RefreshToken rt = session.tokens().decode(raw, RefreshToken.class);
        if (rt == null || rt.getSessionId() == null) return; // Keycloak refuses a bad token itself
        RealmModel realm = session.getContext().getRealm();
        boolean offline = "Offline".equalsIgnoreCase(rt.getType());
        UserSessionModel us = offline ? session.sessions().getOfflineUserSession(realm, rt.getSessionId()) : session.sessions().getUserSession(realm, rt.getSessionId());
        if (us == null || us.getUser() == null) return;
        UserModel user = us.getUser();
        String email = user.getEmail() == null ? "" : user.getEmail().toLowerCase();
        SignInPolicy policy = Orgs.policyFor(session, EmailDomains.domainOf(email)).policy();
        String method = us.getNote(CivicosSignInAuthenticator.US_METHOD);
        String reason = SessionRules.refusal(method, us.getStarted(), Time.currentTime(), policy,
            user.getFirstAttribute(MailboxCheck.ATTRIBUTE), RealmSettings.ssoSessionMaxSeconds(realm), RealmSettings.mailboxMaxAgeSeconds(realm));
        if (reason == null) return;
        LOG.infof("CivicOS session rules: refresh refused for user %s (%s): %s; session ended", user.getId(), method, reason);
        endSession(session.getKeycloakSessionFactory(), realm.getId(), us.getId(), offline);
        throw new ClientPolicyException(OAuthErrorException.INVALID_GRANT, "Sign in again: " + reason);
    }

    /** In its own transaction, so it holds even though the refresh request itself fails. */
    static void endSession(KeycloakSessionFactory factory, String realmId, String sessionId, boolean offline) {
        try {
            KeycloakModelUtils.runJobInTransaction(factory, s -> {
                RealmModel r = s.realms().getRealm(realmId);
                s.getContext().setRealm(r);
                if (offline) {
                    UserSessionModel u = s.sessions().getOfflineUserSession(r, sessionId);
                    if (u != null) s.sessions().removeOfflineUserSession(r, u);
                }
                UserSessionModel u = s.sessions().getUserSession(r, sessionId);
                if (u != null) s.sessions().removeUserSession(r, u);
            });
        } catch (RuntimeException e) {
            LOG.warnf(e, "CivicOS session rules: could not end session %s", sessionId);
        }
    }

    public static class Factory implements ClientPolicyExecutorProviderFactory {
        @Override public ClientPolicyExecutorProvider create(KeycloakSession session) { return new SessionRulesExecutor(session); }
        @Override public void init(Config.Scope config) { }
        @Override public void postInit(KeycloakSessionFactory factory) { }
        @Override public void close() { }
        @Override public String getId() { return ID; }
        @Override public String getHelpText() { return "CivicOS: refuse a token refresh when the session no longer meets the sign-in rules (SSO session over 12 hours, organisation now SSO only, mailbox check over 30 days)."; }
        @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    }
}
