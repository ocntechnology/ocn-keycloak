package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.broker.util.PostBrokerLoginConstants;
import org.keycloak.authentication.authenticators.broker.util.SerializedBrokeredIdentityContext;
import org.keycloak.authentication.authenticators.util.AcrStore;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.sessions.AuthenticationSessionModel;

/** Every council SSO sign-in (post-broker-login flow): level 2, method "sso", organisation membership. */
public class SsoCompleteAuthenticator implements Authenticator {

    @Override
    public void authenticate(AuthenticationFlowContext ctx) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        UserModel user = ctx.getUser();
        SerializedBrokeredIdentityContext serialized = SerializedBrokeredIdentityContext.readFromAuthenticationSession(as, PostBrokerLoginConstants.PBL_BROKERED_IDENTITY_CONTEXT);
        if (user == null || serialized == null) {
            ctx.failure(AuthenticationFlowError.INVALID_USER);
            return;
        }
        BrokeredIdentityContext broker = serialized.deserialize(ctx.getSession(), as);
        // Defence in depth: the account's own email must be at a domain of this IdP's organisation.
        String problem = BrokerGuardAuthenticator.check(ctx.getSession(), broker.getIdpConfig(), user.getEmail());
        if (problem != null) {
            ctx.getEvent().detail("reason", problem);
            ctx.failureChallenge(AuthenticationFlowError.ACCESS_DENIED, ctx.form().setError(problem).createErrorPage(Response.Status.FORBIDDEN));
            return;
        }
        new AcrStore(ctx.getSession(), as).setLevelAuthenticated(Assurance.STRONG);
        as.setUserSessionNote(CivicosSignInAuthenticator.US_LEVEL, Integer.toString(Assurance.STRONG));
        as.setUserSessionNote(CivicosSignInAuthenticator.US_METHOD, "sso");
        user.setSingleAttribute(CivicosSignInAuthenticator.A_LAST_METHOD, "sso");
        OrganizationProvider p = ctx.getSession().getProvider(OrganizationProvider.class);
        String orgId = broker.getIdpConfig().getOrganizationId();
        OrganizationModel org = orgId == null || p == null ? null : p.getById(orgId);
        String domain = EmailDomains.domainOf(user.getEmail());
        if (org != null && org.getDomains().anyMatch(d -> d.getName().equalsIgnoreCase(domain))) {
            Orgs.ensureMember(ctx.getSession(), user, org.getAlias());
        }
        ctx.getEvent().detail("civicos_method", "sso").detail("civicos_level", "2");
        ctx.success();
    }

    @Override public void action(AuthenticationFlowContext ctx) { }
    @Override public boolean requiresUser() { return true; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
