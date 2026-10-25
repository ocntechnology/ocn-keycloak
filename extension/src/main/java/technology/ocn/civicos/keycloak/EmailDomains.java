package technology.ocn.civicos.keycloak;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Email address rules: format, domain, and the personal domains CivicOS never accepts as an account email. */
public final class EmailDomains {
    private EmailDomains() {}

    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$");

    /** Keep in step with PERSONAL_EMAIL_DOMAINS in @civicos/auth (packages/auth/src/oidc/claims.ts). */
    public static final Set<String> PERSONAL = Set.of(
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk",
        "msn.com", "icloud.com", "me.com", "mac.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com",
        "aol.com", "aol.co.uk", "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.co.uk", "mail.com",
        "zoho.com", "btinternet.com", "btopenworld.com", "sky.com", "talktalk.net", "virginmedia.com",
        "ntlworld.com", "blueyonder.co.uk", "tiscali.co.uk", "plus.net", "yandex.com", "fastmail.com", "hey.com");

    private static final Pattern PERSONAL_FAMILY = Pattern.compile("^(yahoo|hotmail|outlook|live|gmx|aol)\\.[a-z.]+$");

    /** Lower-cased, trimmed address, or null if it is not a plausible email address. */
    public static String normalise(String raw) {
        if (raw == null) return null;
        String e = raw.trim().toLowerCase(Locale.ROOT);
        if (e.length() > 254 || !EMAIL.matcher(e).matches()) return null;
        return e;
    }

    public static String domainOf(String email) {
        int at = email.lastIndexOf('@');
        return at < 0 ? "" : email.substring(at + 1).toLowerCase(Locale.ROOT);
    }

    public static boolean isPersonal(String emailOrDomain) {
        String d = emailOrDomain.contains("@") ? domainOf(emailOrDomain) : emailOrDomain.toLowerCase(Locale.ROOT).trim();
        return PERSONAL.contains(d) || PERSONAL_FAMILY.matcher(d).matches();
    }
}
