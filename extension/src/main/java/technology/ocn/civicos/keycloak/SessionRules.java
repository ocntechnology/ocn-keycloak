package technology.ocn.civicos.keycloak;

import java.time.Instant;

/**
 * Whether an existing Keycloak session may carry on (a token refresh, or re-use of the browser
 * session). Pure decision, tested in PolicyLogicTest; {@link SessionRulesExecutor} applies it at
 * every refresh and {@link CivicosSignInAuthenticator} when a browser session is re-used.
 */
public final class SessionRules {
    private SessionRules() {}

    /**
     * @param method          the session's sign-in method ("sso", "password", "email_code"; null means password)
     * @param startedSeconds  when the session started (epoch seconds)
     * @param nowSeconds      now (epoch seconds)
     * @param policy          the organisation's current sign-in policy for the person's email domain
     * @param mailboxVerified the person's {@code civicosMailboxVerifiedAt} attribute, or null
     * @return null if the session may carry on, else a short reason for the logs
     */
    public static String refusal(String method, long startedSeconds, long nowSeconds, SignInPolicy policy,
                                 String mailboxVerified, long ssoMaxSeconds, long mailboxMaxAgeSeconds) {
        boolean sso = "sso".equals(method);
        if (sso && nowSeconds - startedSeconds > ssoMaxSeconds) return "council SSO session older than " + ssoMaxSeconds + " seconds";
        if (!sso && policy == SignInPolicy.SSO_REQUIRED) return "organisation now requires council SSO";
        if (!sso && MailboxCheck.due(mailboxVerified, Instant.ofEpochSecond(nowSeconds), mailboxMaxAgeSeconds)) return "mailbox check older than " + mailboxMaxAgeSeconds + " seconds";
        return null;
    }
}
