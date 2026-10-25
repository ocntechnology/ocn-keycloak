package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.authenticators.broker.AbstractIdpAuthenticator;
import org.keycloak.authentication.authenticators.broker.util.SerializedBrokeredIdentityContext;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;

/**
 * First council SSO sign-in: before the account is created or linked by email, check that the
 * council's identity provider vouches for an address at a domain that council owns. A Microsoft
 * sign-in from another tenant, or for another council's domain, can never take over an account.
 */
public class BrokerGuardAuthenticator extends AbstractIdpAuthenticator {

    @Override
    protected void authenticateImpl(AuthenticationFlowContext ctx, SerializedBrokeredIdentityContext serialized, BrokeredIdentityContext broker) {
        String problem = check(ctx.getSession(), broker.getIdpConfig(), broker.getEmail());
        if (problem != null) {
            ctx.getEvent().detail("reason", problem);
            sendFailureChallenge(ctx, Response.Status.FORBIDDEN, "civicos_sso_refused", problem, AuthenticationFlowError.ACCESS_DENIED);
            return;
        }
        ctx.success();
    }

    /** Null if the brokered email may be used, else the message key explaining why not. */
    static String check(KeycloakSession session, IdentityProviderModel idp, String rawEmail) {
        String email = EmailDomains.normalise(rawEmail);
        if (email == null) return "civicosSsoNoEmail";
        if (EmailDomains.isPersonal(email)) return "civicosPersonalEmail";
        if (!idp.isTrustEmail()) return "civicosSsoUntrusted";
        String orgId = idp.getOrganizationId();
        OrganizationProvider p = session.getProvider(OrganizationProvider.class);
        OrganizationModel org = orgId == null || p == null ? null : p.getById(orgId);
        if (org == null || !org.isEnabled()) return "civicosSsoNoOrganisation";
        if (!Orgs.domainsOf(org).contains(EmailDomains.domainOf(email))) return "civicosSsoWrongDomain";
        return null;
    }

    @Override
    protected void actionImpl(AuthenticationFlowContext ctx, SerializedBrokeredIdentityContext serialized, BrokeredIdentityContext broker) { }

    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
}
