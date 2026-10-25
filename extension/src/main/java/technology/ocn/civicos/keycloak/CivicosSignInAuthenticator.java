package technology.ocn.civicos.keycloak;

import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.AbstractUsernameFormAuthenticator;
import org.keycloak.authentication.authenticators.util.AcrStore;
import org.keycloak.authentication.authenticators.util.AuthenticatorUtils;
import org.keycloak.common.util.Time;
import org.keycloak.credential.CredentialModel;
import org.keycloak.email.EmailException;
import org.keycloak.events.Errors;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserCredentialModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.models.credential.PasswordCredentialModel;
import org.keycloak.protocol.LoginProtocol;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.managers.ClientSessionCode;
import org.keycloak.sessions.AuthenticationSessionModel;

/**
 * CivicOS sign-in policy: the whole browser sign-in in one authenticator.
 *
 * <ol>
 *   <li>Existing Keycloak session: re-use it at its recorded level, unless the client asks for
 *       a higher level (step-up), the organisation now requires SSO, or an SSO session is older
 *       than 12 hours.</li>
 *   <li>Email first. Personal domains are refused. The domain picks the organisation and its
 *       policy. An unregistered work domain gets in only if the account already exists (invited).</li>
 *   <li>Password, email code or council SSO, as the policy allows.</li>
 *   <li>30-day mailbox check for password sign-ins.</li>
 *   <li>Second step (authenticator app) where the organisation or the client requires it.</li>
 *   <li>Assurance level (acr) 1 or 2 recorded on the session.</li>
 * </ol>
 */
public class CivicosSignInAuthenticator implements Authenticator {
    private static final Logger LOG = Logger.getLogger(CivicosSignInAuthenticator.class);

    static final String N_STAGE = "civicos.stage";
    static final String N_EMAIL = "civicos.email";
    static final String N_METHOD = "civicos.method";
    static final String N_SECOND = "civicos.second";
    static final String N_STEPUP = "civicos.stepup";
    static final String N_ORG = "civicos.org";
    /** User-session notes (copied to the session; the method is also a token claim). */
    public static final String US_LEVEL = "civicos.level";
    public static final String US_METHOD = "civicos.method";
    public static final String A_LAST_METHOD = "civicosLastSignInMethod";

    static final String F_EMAIL = "civicos-email.ftl";
    static final String F_CHOOSE = "civicos-choose.ftl";
    static final String F_PASSWORD = "civicos-password.ftl";
    static final String F_CODE = "civicos-code.ftl";
    static final String F_OTP = "civicos-otp.ftl";

    @Override
    public void authenticate(AuthenticationFlowContext ctx) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        if (tryExistingSession(ctx)) return;
        clearNotes(as);
        String hint = as.getClientNote("login_hint");
        String email = EmailDomains.normalise(hint);
        ctx.challenge(emailForm(ctx, email != null ? email : "", null));
    }

    /** Returns true if it has finished the step (success or a redirect). */
    private boolean tryExistingSession(AuthenticationFlowContext ctx) {
        KeycloakSession session = ctx.getSession();
        RealmModel realm = ctx.getRealm();
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        AuthenticationManager.AuthResult r = AuthenticationManager.authenticateIdentityCookie(session, realm, true);
        if (r == null) return false;
        LoginProtocol protocol = session.getProvider(LoginProtocol.class, as.getProtocol());
        if (protocol != null && protocol.requireReauthentication(r.getSession(), as)) return false;
        UserModel user = r.getUser();
        UserSessionModel us = r.getSession();
        String method = Optional.ofNullable(us.getNote(US_METHOD)).orElse("password");
        int prev = parseInt(us.getNote(US_LEVEL), Assurance.VERIFIED_EMAIL);
        String email = user.getEmail() == null ? "" : user.getEmail().toLowerCase();
        OrgPolicy org = Orgs.policyFor(session, EmailDomains.domainOf(email));
        AcrStore acr = new AcrStore(session, as);
        int requested = acr.getRequestedLevelOfAuthentication(ctx.getTopLevelFlow());

        // Policy changed to SSO only, or an SSO session is past 12 hours: back through the council's sign-in.
        boolean ssoNow = org.policy() == SignInPolicy.SSO_REQUIRED && !"sso".equals(method);
        boolean ssoStale = "sso".equals(method) && Time.currentTime() - us.getStarted() > Assurance.SSO_SESSION_SECONDS;
        if ((ssoNow || ssoStale) && org.ssoConnected()) {
            redirectToIdp(ctx, org.idpAliases().get(0), email);
            return true;
        }
        if (ssoNow) return false; // SSO required but not connected: show the email screen, which explains.

        ctx.setUser(user);
        if (requested > prev) {
            // Step-up on an existing session: only the second step is needed.
            as.setAuthNote(N_EMAIL, email);
            as.setAuthNote(N_METHOD, method);
            as.setAuthNote(N_STEPUP, "true");
            as.setAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME, email);
            if (org.singleAlias() != null) as.setAuthNote(N_ORG, org.singleAlias());
            if (org.ssoConnected() && hasIdpLink(session, realm, user, org.idpAliases().get(0))) {
                redirectToIdp(ctx, org.idpAliases().get(0), email);
                return true;
            }
            secondFactorOrSetup(ctx, user, true);
            return true;
        }
        acr.setLevelAuthenticatedToCurrentRequest(prev);
        as.setAuthNote("SSO_AUTH", "true");
        ctx.attachUserSession(us);
        ctx.success();
        return true;
    }

    @Override
    public void action(AuthenticationFlowContext ctx) {
        MultivaluedMap<String, String> form = ctx.getHttpRequest().getDecodedFormParameters();
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        if (form.containsKey("restart")) {
            clearNotes(as);
            ctx.clearUser();
            ctx.challenge(emailForm(ctx, "", null));
            return;
        }
        String stage = Optional.ofNullable(as.getAuthNote(N_STAGE)).orElse("identify");
        switch (stage) {
            case "identify" -> identify(ctx, form.getFirst("email"));
            case "choose" -> choose(ctx, form.getFirst("method"));
            case "password" -> password(ctx, form);
            case "code", "mailbox" -> code(ctx, form, "mailbox".equals(stage));
            case "otp" -> otp(ctx, form.getFirst("otp"));
            default -> ctx.challenge(emailForm(ctx, "", null));
        }
    }

    // 1. Email first ------------------------------------------------------------------------------

    void identify(AuthenticationFlowContext ctx, String raw) {
        KeycloakSession session = ctx.getSession();
        RealmModel realm = ctx.getRealm();
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String email = EmailDomains.normalise(raw);
        OrgPolicy org = email == null ? OrgPolicy.NONE : Orgs.policyFor(session, EmailDomains.domainOf(email));
        UserModel user = email == null ? null : session.users().getUserByEmail(realm, email);
        boolean hasPassword = user != null && user.credentialManager().isConfiguredFor(PasswordCredentialModel.TYPE);
        Route route = Route.decide(email, org, user != null, user != null && user.isEnabled(), hasPassword);
        String shown = raw == null ? "" : raw.trim();
        switch (route.kind) {
            case INVALID_EMAIL -> { ctx.challenge(emailForm(ctx, shown, "civicosInvalidEmail")); return; }
            case PERSONAL_EMAIL -> { ctx.getEvent().detail("reason", "personal_email").error(Errors.INVALID_USER); ctx.challenge(emailForm(ctx, shown, "civicosPersonalEmail")); return; }
            case UNKNOWN_DOMAIN -> { ctx.getEvent().detail("reason", "unknown_domain").error(Errors.USER_NOT_FOUND); ctx.challenge(emailForm(ctx, shown, "civicosUnknownDomain")); return; }
            case ACCOUNT_DISABLED -> { ctx.getEvent().user(user).error(Errors.USER_DISABLED); ctx.challenge(emailForm(ctx, shown, "civicosAccountDisabled")); return; }
            case SSO_NOT_CONNECTED -> { ctx.challenge(emailForm(ctx, shown, "civicosSsoNotConnected")); return; }
            default -> { }
        }
        as.setAuthNote(N_EMAIL, email);
        as.setAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME, email);
        if (org.singleAlias() != null) as.setAuthNote(N_ORG, org.singleAlias());
        switch (route.kind) {
            case SSO_REDIRECT -> redirectToIdp(ctx, route.idpAlias, email);
            case CHOOSE -> {
                as.setAuthNote(N_STAGE, "choose");
                ctx.challenge(chooseForm(ctx, route.idpAlias, route.offerPassword, null));
            }
            case PASSWORD -> {
                as.setAuthNote(N_STAGE, "password");
                ctx.challenge(passwordForm(ctx, null));
            }
            default -> sendCodeAndShow(ctx, false, null);
        }
    }

    void choose(AuthenticationFlowContext ctx, String method) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String email = as.getAuthNote(N_EMAIL);
        OrgPolicy org = Orgs.policyFor(ctx.getSession(), EmailDomains.domainOf(email));
        UserModel user = ctx.getSession().users().getUserByEmail(ctx.getRealm(), email);
        if ("sso".equals(method) && org.ssoConnected()) {
            redirectToIdp(ctx, org.idpAliases().get(0), email);
        } else if ("password".equals(method) && user != null && org.policy().allowsPasswordAndCode()) {
            as.setAuthNote(N_STAGE, "password");
            ctx.challenge(passwordForm(ctx, null));
        } else if ("code".equals(method) && org.policy().allowsPasswordAndCode()) {
            sendCodeAndShow(ctx, false, null);
        } else {
            ctx.challenge(chooseForm(ctx, org.ssoConnected() ? org.idpAliases().get(0) : null, user != null, null));
        }
    }

    // 2. Password ---------------------------------------------------------------------------------

    void password(AuthenticationFlowContext ctx, MultivaluedMap<String, String> form) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        if (form.containsKey("useCode")) {
            sendCodeAndShow(ctx, false, null);
            return;
        }
        String email = as.getAuthNote(N_EMAIL);
        UserModel user = ctx.getSession().users().getUserByEmail(ctx.getRealm(), email);
        OrgPolicy org = Orgs.policyFor(ctx.getSession(), EmailDomains.domainOf(email));
        if (user == null || !org.policy().allowsPasswordAndCode()) {
            ctx.challenge(emailForm(ctx, email, "civicosSignInFailed"));
            return;
        }
        String locked = AuthenticatorUtils.getDisabledByBruteForceEventError(ctx, user);
        if (locked != null) {
            ctx.getEvent().user(user).error(locked);
            ctx.challenge(passwordForm(ctx, "civicosLockedOut"));
            return;
        }
        String pw = form.getFirst("password");
        boolean ok = pw != null && !pw.isEmpty() && user.credentialManager().isValid(UserCredentialModel.password(pw));
        if (!ok) {
            ctx.setUser(user); // so brute-force protection counts the failure
            ctx.getEvent().user(user).error(Errors.INVALID_USER_CREDENTIALS);
            ctx.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, passwordForm(ctx, "civicosWrongPassword"));
            ctx.clearUser();
            return;
        }
        as.setAuthNote(N_METHOD, "password");
        afterPrimary(ctx, user);
    }

    // 3. Email code -------------------------------------------------------------------------------

    void sendCodeAndShow(AuthenticationFlowContext ctx, boolean mailboxCheck, String info) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String email = as.getAuthNote(N_EMAIL);
        EmailCode.Notes notes = notes(as);
        long now = Time.currentTime();
        as.setAuthNote(N_STAGE, mailboxCheck ? "mailbox" : "code");
        if (EmailCode.hasCode(notes) && !EmailCode.canResend(notes, now)) {
            ctx.challenge(codeForm(ctx, mailboxCheck, "civicosCodeWait", null));
            return;
        }
        String code = EmailCode.issue(notes, now);
        try {
            CodeMailer.send(ctx.getSession(), ctx.getRealm(), email, code, mailboxCheck);
        } catch (EmailException e) {
            LOG.warnf(e, "could not send CivicOS sign-in code to %s", email);
            EmailCode.clear(notes);
            ctx.challenge(codeForm(ctx, mailboxCheck, null, "civicosCodeNotSent"));
            return;
        }
        ctx.getEvent().detail("civicos_code_sent", "true");
        ctx.challenge(codeForm(ctx, mailboxCheck, info, null));
    }

    void code(AuthenticationFlowContext ctx, MultivaluedMap<String, String> form, boolean mailboxCheck) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        if (form.containsKey("resend")) {
            sendCodeAndShow(ctx, mailboxCheck, "civicosCodeResent");
            return;
        }
        String email = as.getAuthNote(N_EMAIL);
        KeycloakSession session = ctx.getSession();
        RealmModel realm = ctx.getRealm();
        UserModel user = session.users().getUserByEmail(realm, email);
        if (user != null) {
            String locked = AuthenticatorUtils.getDisabledByBruteForceEventError(ctx, user);
            if (locked != null) {
                ctx.getEvent().user(user).error(locked);
                ctx.challenge(codeForm(ctx, mailboxCheck, null, "civicosLockedOut"));
                return;
            }
        }
        EmailCode.Result result = EmailCode.verify(notes(as), form.getFirst("code"), Time.currentTime());
        switch (result) {
            case OK -> { }
            case WRONG -> {
                if (user != null) ctx.setUser(user);
                ctx.getEvent().user(user).error(Errors.INVALID_USER_CREDENTIALS);
                ctx.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, codeForm(ctx, mailboxCheck, null, "civicosWrongCode"));
                if (user != null) ctx.clearUser();
                return;
            }
            case EXPIRED -> { ctx.challenge(codeForm(ctx, mailboxCheck, null, "civicosCodeExpired")); return; }
            case TOO_MANY_ATTEMPTS -> { ctx.challenge(codeForm(ctx, mailboxCheck, null, "civicosCodeTooManyAttempts")); return; }
            case NO_CODE -> { ctx.challenge(codeForm(ctx, mailboxCheck, null, "civicosCodeExpired")); return; }
        }
        if (user == null) {
            // First sign-in at a registered organisation: create the account now the mailbox is proved.
            OrgPolicy org = Orgs.policyFor(session, EmailDomains.domainOf(email));
            if (!org.registered() || EmailDomains.isPersonal(email)) {
                ctx.challenge(emailForm(ctx, email, "civicosUnknownDomain"));
                return;
            }
            user = session.users().addUser(realm, email, email, true, true);
            user.setEnabled(true);
            user.setEmail(email);
            user.setEmailVerified(true);
            user.addRequiredAction(UserModel.RequiredAction.UPDATE_PROFILE);
            ctx.getEvent().detail("civicos_account_created", "true");
        } else if (!user.isEmailVerified()) {
            user.setEmailVerified(true);
        }
        user.setSingleAttribute(MailboxCheck.ATTRIBUTE, Instant.now().toString());
        if (!mailboxCheck) as.setAuthNote(N_METHOD, "email_code");
        afterPrimary(ctx, user);
    }

    // 4. After the first step: mailbox check, second factor, finish -------------------------------

    void afterPrimary(AuthenticationFlowContext ctx, UserModel user) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String method = as.getAuthNote(N_METHOD);
        if ("password".equals(method) && !"mailbox".equals(as.getAuthNote(N_STAGE))
                && MailboxCheck.due(user.getFirstAttribute(MailboxCheck.ATTRIBUTE), Instant.now())) {
            sendCodeAndShow(ctx, true, null);
            return;
        }
        secondFactorOrSetup(ctx, user, false);
    }

    void secondFactorOrSetup(AuthenticationFlowContext ctx, UserModel user, boolean stepUp) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String method = as.getAuthNote(N_METHOD);
        String email = as.getAuthNote(N_EMAIL);
        OrgPolicy org = Orgs.policyFor(ctx.getSession(), EmailDomains.domainOf(email == null ? "" : email));
        int requested = new AcrStore(ctx.getSession(), as).getRequestedLevelOfAuthentication(ctx.getTopLevelFlow());
        boolean hasOtp = user.credentialManager().isConfiguredFor(OTPCredentialModel.TYPE);
        if (Assurance.needsSecondFactor(method, org.requireSecondFactor(), requested, hasOtp)) {
            ctx.setUser(user);
            if (hasOtp) {
                as.setAuthNote(N_STAGE, "otp");
                ctx.challenge(otpForm(ctx, stepUp ? "civicosStepUpInfo" : null, null));
                return;
            }
            // No authenticator app yet: set one up now. Keycloak's CONFIGURE_TOTP checks a code before
            // finishing, so the session is level 2 only once that succeeds.
            user.addRequiredAction(UserModel.RequiredAction.CONFIGURE_TOTP);
            as.setAuthNote(N_SECOND, "true");
        }
        finish(ctx, user);
    }

    void otp(AuthenticationFlowContext ctx, String code) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        UserModel user = ctx.getUser();
        if (user == null) user = ctx.getSession().users().getUserByEmail(ctx.getRealm(), as.getAuthNote(N_EMAIL));
        if (user == null) { ctx.challenge(emailForm(ctx, "", null)); return; }
        String locked = AuthenticatorUtils.getDisabledByBruteForceEventError(ctx, user);
        if (locked != null) {
            ctx.getEvent().user(user).error(locked);
            ctx.challenge(otpForm(ctx, null, "civicosLockedOut"));
            return;
        }
        Optional<CredentialModel> cred = user.credentialManager().getStoredCredentialsByTypeStream(OTPCredentialModel.TYPE).findFirst();
        String clean = code == null ? "" : code.replaceAll("\\s", "");
        boolean ok = cred.isPresent() && !clean.isEmpty() && user.credentialManager().isValid(new UserCredentialModel(cred.get().getId(), OTPCredentialModel.TYPE, clean));
        if (!ok) {
            ctx.setUser(user);
            ctx.getEvent().user(user).error(Errors.INVALID_USER_CREDENTIALS);
            ctx.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, otpForm(ctx, null, "civicosWrongOtp"));
            return;
        }
        as.setAuthNote(N_SECOND, "true");
        finish(ctx, user);
    }

    void finish(AuthenticationFlowContext ctx, UserModel user) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String method = Optional.ofNullable(as.getAuthNote(N_METHOD)).orElse("password");
        int level = Assurance.level(method, "true".equals(as.getAuthNote(N_SECOND)));
        new AcrStore(ctx.getSession(), as).setLevelAuthenticated(level);
        as.setUserSessionNote(US_LEVEL, Integer.toString(level));
        as.setUserSessionNote(US_METHOD, method);
        user.setSingleAttribute(A_LAST_METHOD, method);
        Orgs.ensureMember(ctx.getSession(), user, as.getAuthNote(N_ORG));
        ctx.getEvent().detail("civicos_method", method).detail("civicos_level", Integer.toString(level));
        ctx.setUser(user);
        clearNotes(as);
        ctx.success();
    }

    // SSO -----------------------------------------------------------------------------------------

    static boolean hasIdpLink(KeycloakSession session, RealmModel realm, UserModel user, String alias) {
        return session.users().getFederatedIdentitiesStream(realm, user).anyMatch(f -> alias.equals(f.getIdentityProvider()));
    }

    void redirectToIdp(AuthenticationFlowContext ctx, String alias, String email) {
        KeycloakSession session = ctx.getSession();
        IdentityProviderModel idp = session.identityProviders().getByAlias(alias);
        if (idp == null || !idp.isEnabled()) {
            ctx.challenge(emailForm(ctx, email, "civicosSsoNotConnected"));
            return;
        }
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        String accessCode = new ClientSessionCode<>(session, ctx.getRealm(), as).getOrGenerateCode();
        String clientData = AuthenticationProcessor.getClientData(session, as);
        URI location = Urls.identityProviderAuthnRequest(ctx.getUriInfo().getBaseUri(), alias, ctx.getRealm().getName(), accessCode,
            as.getClient().getClientId(), as.getTabId(), clientData, email);
        ctx.forceChallenge(Response.seeOther(location).build());
    }

    // Forms ---------------------------------------------------------------------------------------

    LoginFormsProvider base(AuthenticationFlowContext ctx) {
        AuthenticationSessionModel as = ctx.getAuthenticationSession();
        LoginFormsProvider f = ctx.form();
        f.setAttribute("civicosEmail", Optional.ofNullable(as.getAuthNote(N_EMAIL)).orElse(""));
        String org = as.getAuthNote(N_ORG);
        if (org != null) {
            var o = ctx.getSession().getProvider(org.keycloak.organization.OrganizationProvider.class).getByAlias(org);
            if (o != null) f.setAttribute("civicosOrgName", o.getName());
        }
        return f;
    }

    Response emailForm(AuthenticationFlowContext ctx, String value, String error) {
        LoginFormsProvider f = base(ctx).setAttribute("civicosEmailValue", value == null ? "" : value);
        if (error != null) f.setError(error);
        return f.createForm(F_EMAIL);
    }

    Response chooseForm(AuthenticationFlowContext ctx, String idpAlias, boolean offerPassword, String error) {
        LoginFormsProvider f = base(ctx);
        IdentityProviderModel idp = idpAlias == null ? null : ctx.getSession().identityProviders().getByAlias(idpAlias);
        f.setAttribute("civicosSsoName", idp == null ? null : Optional.ofNullable(idp.getDisplayName()).orElse(idp.getAlias()));
        f.setAttribute("civicosOfferPassword", offerPassword);
        if (error != null) f.setError(error);
        return f.createForm(F_CHOOSE);
    }

    Response passwordForm(AuthenticationFlowContext ctx, String error) {
        LoginFormsProvider f = base(ctx);
        String email = ctx.getAuthenticationSession().getAuthNote(N_EMAIL);
        OrgPolicy org = email == null ? OrgPolicy.NONE : Orgs.policyFor(ctx.getSession(), EmailDomains.domainOf(email));
        f.setAttribute("civicosOfferSso", org.policy() == SignInPolicy.SSO_AVAILABLE && org.ssoConnected());
        if (error != null) f.setError(error);
        return f.createForm(F_PASSWORD);
    }

    Response codeForm(AuthenticationFlowContext ctx, boolean mailboxCheck, String info, String error) {
        LoginFormsProvider f = base(ctx).setAttribute("civicosMailboxCheck", mailboxCheck);
        f.setAttribute("civicosAttemptsLeft", EmailCode.attemptsLeft(notes(ctx.getAuthenticationSession())));
        if (info != null) f.setInfo(info);
        if (error != null) f.setError(error);
        return f.createForm(F_CODE);
    }

    Response otpForm(AuthenticationFlowContext ctx, String info, String error) {
        LoginFormsProvider f = base(ctx);
        if (info != null) f.setInfo(info);
        if (error != null) f.setError(error);
        return f.createForm(F_OTP);
    }

    // Helpers -------------------------------------------------------------------------------------

    static EmailCode.Notes notes(AuthenticationSessionModel as) {
        return new EmailCode.Notes() {
            public String get(String k) { return as.getAuthNote(k); }
            public void set(String k, String v) { as.setAuthNote(k, v); }
            public void remove(String k) { as.removeAuthNote(k); }
        };
    }

    static void clearNotes(AuthenticationSessionModel as) {
        for (String k : List.of(N_STAGE, N_EMAIL, N_METHOD, N_SECOND, N_STEPUP, N_ORG)) as.removeAuthNote(k);
        EmailCode.clear(notes(as));
        as.removeAuthNote(EmailCode.N_SENT);
    }

    static int parseInt(String s, int dflt) {
        try { return s == null ? dflt : Integer.parseInt(s); } catch (NumberFormatException e) { return dflt; }
    }

    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
