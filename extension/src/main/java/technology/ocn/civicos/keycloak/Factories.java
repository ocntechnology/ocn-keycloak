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
