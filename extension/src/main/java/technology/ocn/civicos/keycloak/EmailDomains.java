package technology.ocn.civicos.keycloak;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.keycloak.util.JsonSerialization;

/** Email address rules: format, domain, and the personal domains CivicOS never accepts as an account email. */
public final class EmailDomains {
    private EmailDomains() {}

    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$");

    /**
     * The one list of personal (free-mail) domains: {@code personal-email-domains.json}, a
     * byte-identical copy of {@code packages/auth/src/personal-email-domains.json} in the civicos
     * repo (scripts/check-personal-domains.mjs compares them). Exact domains plus anchored patterns.
     */
    public static final String RESOURCE = "/personal-email-domains.json";
    public static final Set<String> PERSONAL;
    private static final List<Pattern> PERSONAL_PATTERNS;

    static {
        try (InputStream in = EmailDomains.class.getResourceAsStream(RESOURCE)) {
            if (in == null) throw new IllegalStateException(RESOURCE + " is missing from the extension");
            @SuppressWarnings("unchecked")
            Map<String, Object> json = JsonSerialization.readValue(in, Map.class);
            @SuppressWarnings("unchecked")
            List<String> domains = (List<String>) json.get("domains");
            @SuppressWarnings("unchecked")
            List<String> patterns = (List<String>) json.getOrDefault("patterns", List.of());
            PERSONAL = Set.copyOf(domains.stream().map(d -> d.trim().toLowerCase(Locale.ROOT)).toList());
            PERSONAL_PATTERNS = patterns.stream().map(Pattern::compile).toList();
        } catch (IOException e) {
            throw new IllegalStateException("cannot read " + RESOURCE, e);
        }
    }

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
        if (PERSONAL.contains(d)) return true;
        for (Pattern p : PERSONAL_PATTERNS) if (p.matcher(d).matches()) return true;
        return false;
    }
}
