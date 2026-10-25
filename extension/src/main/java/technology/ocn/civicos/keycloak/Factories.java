package technology.ocn.civicos.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

/** Authenticator factories registered in META-INF/services. */
public final class Factories {
    private Factories() {}

    abstract static class Base implements AuthenticatorFactory {
        private static final AuthenticationExecutionModel.Requirement[] CHOICES = { AuthenticationExecutionModel.Requirement.REQUIRED, AuthenticationExecutionModel.Requirement.DISABLED };
        @Override public String getReferenceCategory() { return "civicos"; }
        @Override public boolean isConfigurable() { return false; }
        @Override public AuthenticationExecutionModel.Requirement[] getRequirementChoices() { return CHOICES; }
        @Override public boolean isUserSetupAllowed() { return false; }
        @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
        @Override public void init(Config.Scope config) { }
        @Override public void postInit(KeycloakSessionFactory factory) { }
        @Override public void close() { }
    }

    public static class SignIn extends Base {
        public static final String ID = "civicos-sign-in";
        private static final CivicosSignInAuthenticator INSTANCE = new CivicosSignInAuthenticator();
        @Override public String getId() { return ID; }
        @Override public String getDisplayType() { return "CivicOS sign-in policy"; }
        @Override public String getHelpText() { return "Email first; applies the organisation's sign-in policy (password, email code, council SSO), the 30-day mailbox check, second step and assurance level."; }
        @Override public Authenticator create(KeycloakSession session) { return INSTANCE; }
    }

    public static class Reset extends Base {
        public static final String ID = "civicos-reset-identify";
        private static final CivicosResetAuthenticator INSTANCE = new CivicosResetAuthenticator();
        @Override public String getId() { return ID; }
        @Override public String getDisplayType() { return "CivicOS reset: email and policy"; }
        @Override public String getHelpText() { return "Forgotten password: asks for the email and applies the sign-in routing (no reset for SSO-required organisations, personal or unknown domains); checks again when the emailed link is used."; }
        @Override public Authenticator create(KeycloakSession session) { return INSTANCE; }
    }

    /** Bound as the realm's direct grant flow: a password grant always gets an OAuth error, never tokens. */
    public static class RefusePasswordGrant extends Base {
        public static final String ID = "civicos-refuse-password-grant";
        private static final Authenticator INSTANCE = new Authenticator() {
            @Override public void authenticate(org.keycloak.authentication.AuthenticationFlowContext ctx) {
                ctx.getEvent().detail("reason", "password_grant_not_allowed");
                ctx.failure(org.keycloak.authentication.AuthenticationFlowError.ACCESS_DENIED,
                    jakarta.ws.rs.core.Response.status(400).type(jakarta.ws.rs.core.MediaType.APPLICATION_JSON_TYPE)
                        .entity(java.util.Map.of("error", "unauthorized_client", "error_description", "CivicOS does not allow password grants. Sign in through the browser."))
                        .build());
            }
            @Override public void action(org.keycloak.authentication.AuthenticationFlowContext ctx) { authenticate(ctx); }
            @Override public boolean requiresUser() { return false; }
            @Override public boolean configuredFor(KeycloakSession session, org.keycloak.models.RealmModel realm, org.keycloak.models.UserModel user) { return true; }
            @Override public void setRequiredActions(KeycloakSession session, org.keycloak.models.RealmModel realm, org.keycloak.models.UserModel user) { }
            @Override public void close() { }
        };
        @Override public String getId() { return ID; }
        @Override public String getDisplayType() { return "CivicOS: refuse password grants"; }
        @Override public String getHelpText() { return "Always fails with unauthorized_client. Bound as the direct grant flow so no client can get tokens with a password."; }
        @Override public Authenticator create(KeycloakSession session) { return INSTANCE; }
    }

    public static class BrokerGuard extends Base {
        public static final String ID = "civicos-broker-guard";
        private static final BrokerGuardAuthenticator INSTANCE = new BrokerGuardAuthenticator();
        @Override public String getId() { return ID; }
        @Override public String getDisplayType() { return "CivicOS SSO domain guard"; }
        @Override public String getHelpText() { return "First SSO sign-in: the email must be verified and at a domain owned by the identity provider's organisation."; }
        @Override public Authenticator create(KeycloakSession session) { return INSTANCE; }
    }

    public static class SsoComplete extends Base {
        public static final String ID = "civicos-sso-complete";
        private static final SsoCompleteAuthenticator INSTANCE = new SsoCompleteAuthenticator();
        @Override public String getId() { return ID; }
        @Override public String getDisplayType() { return "CivicOS SSO completion"; }
        @Override public String getHelpText() { return "Every SSO sign-in: assurance level 2, sign-in method sso, organisation membership."; }
        @Override public Authenticator create(KeycloakSession session) { return INSTANCE; }
    }
}
