package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.time.Instant;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.DefaultActionTokenKey;
import org.keycloak.authentication.authenticators.browser.AbstractUsernameFormAuthenticator;
import org.keycloak.common.util.Time;
import org.keycloak.events.Errors;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.PasswordCredentialModel;

/**
 * First step of the CivicOS "Forgotten your password?" flow ({@code civicos-reset-credentials}),
 * in place of Keycloak's "Choose user". It applies the same email-first routing as sign-in:
 * personal and unknown domains are refused, a disabled account is refused, and an organisation
 * that requires council SSO has no CivicOS password to reset. When the person comes back through
 * the emailed link the flow runs again from the top: the rules are checked again (the policy may
 * have changed) and the mailbox counts as checked. The flow then sets the new password and, with
 * "Send Reset Email" set to force-login, ends without signing anyone in: the person signs in
 * through the normal flow, so the second step and the staff rules apply.
 */
public class CivicosResetAuthenticator implements Authenticator {
    static final String F_RESET = "civicos-reset.ftl";

    @Override
    public void authenticate(AuthenticationFlowContext ctx) {
        String tokenUserId = ctx.getAuthenticationSession().getAuthNote(DefaultActionTokenKey.ACTION_TOKEN_USER_ID);
        if (tokenUserId != null) {
            // Back from the emailed link.
            UserModel user = ctx.getSession().users().getUserById(ctx.getRealm(), tokenUserId);
            String refusal = user == null ? "civicosSignInFailed" : refusal(ctx.getSession(), user.getEmail(), user);
            if (refusal != null) {
                ctx.getEvent().user(user).detail("reason", refusal).error(Errors.NOT_ALLOWED);
                ctx.failure(AuthenticationFlowError.ACCESS_DENIED, ctx.form().setError(refusal).createErrorPage(Response.Status.FORBIDDEN));
                return;
            }
            user.setEmailVerified(true);
            user.setSingleAttribute(MailboxCheck.ATTRIBUTE, Instant.now().toString());
            ctx.setUser(user);
            ctx.success();
            return;
        }
        String prefill = ctx.getAuthenticationSession().getAuthNote(CivicosSignInAuthenticator.N_EMAIL);
        ctx.challenge(form(ctx, prefill == null ? "" : prefill, null));
    }

    @Override
    public void action(AuthenticationFlowContext ctx) {
        MultivaluedMap<String, String> f = ctx.getHttpRequest().getDecodedFormParameters();
        String raw = f.getFirst("email");
        if (raw == null) raw = f.getFirst("username");
        String shown = raw == null ? "" : raw.trim();
        String email = EmailDomains.normalise(raw);
        KeycloakSession session = ctx.getSession();
        UserModel user = email == null ? null : session.users().getUserByEmail(ctx.getRealm(), email);
        String refusal = email == null ? "civicosInvalidEmail" : refusal(session, email, user);
        if (refusal != null) {
            ctx.getEvent().detail("reason", refusal).error(Errors.INVALID_USER);
            ctx.challenge(form(ctx, shown, refusal));
            return;
        }
        ctx.getAuthenticationSession().setAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME, email);
        if (user == null) {
            // As Keycloak does: carry on without a user, so the next step says "email sent" and sends nothing.
            ctx.clearUser();
            ctx.success();
            return;
        }
        // A reset email counts towards the address's email limit (no mail-bombing through resets).
        CodeLimits.Send send = CodeLimits.trySend(CodeLimits.keycloak(session), RealmSettings.codeLimits(ctx.getRealm()), ctx.getRealm().getId(), email, Time.currentTime());
        if (send != CodeLimits.Send.OK) {
            ctx.challenge(form(ctx, shown, send == CodeLimits.Send.LOCKED ? "civicosCodeLocked" : "civicosTooManyCodes"));
            return;
        }
        ctx.setUser(user);
        ctx.success();
    }

    /** The same rules as the sign-in screen; null if a reset may go ahead. */
    static String refusal(KeycloakSession session, String email, UserModel user) {
        String e = EmailDomains.normalise(email);
        OrgPolicy org = e == null ? OrgPolicy.NONE : Orgs.policyFor(session, EmailDomains.domainOf(e));
        boolean hasPassword = user != null && user.credentialManager().isConfiguredFor(PasswordCredentialModel.TYPE);
        Route route = Route.decide(e, org, user != null, user != null && user.isEnabled(), hasPassword);
        return switch (route.kind) {
            case INVALID_EMAIL -> "civicosInvalidEmail";
            case PERSONAL_EMAIL -> "civicosPersonalEmail";
            case UNKNOWN_DOMAIN -> "civicosUnknownDomain";
            case ACCOUNT_DISABLED -> "civicosAccountDisabled";
            case SSO_NOT_CONNECTED, SSO_REDIRECT -> "civicosResetSsoRequired";
            default -> null;
        };
    }

    Response form(AuthenticationFlowContext ctx, String value, String error) {
        LoginFormsProvider f = ctx.form().setAttribute("civicosEmailValue", value);
        if (error != null) f.setError(error);
        return f.createForm(F_RESET);
    }

    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
