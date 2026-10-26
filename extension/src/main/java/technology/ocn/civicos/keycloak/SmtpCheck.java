package technology.ocn.civicos.keycloak;

import jakarta.mail.Session;
import jakarta.mail.Transport;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CompletableFuture;
import org.jboss.logging.Logger;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.utils.KeycloakModelUtils;

/**
 * Start-up SMTP check: for every realm with an SMTP server, connect (and log in, when the realm
 * uses SMTP authentication) without sending anything. A failure is logged as an ERROR starting
 * "CivicOS SMTP check FAILED", so a missing or wrong production credential shows at deploy time
 * rather than when the first sign-in code cannot be sent.
 */
final class SmtpCheck {
    private static final Logger LOG = Logger.getLogger(SmtpCheck.class);

    private SmtpCheck() {}

    static void runInBackground(KeycloakSessionFactory factory) {
        CompletableFuture.runAsync(() -> {
            try {
                KeycloakModelUtils.runJobInTransaction(factory, s -> s.realms().getRealmsStream().forEach(r -> check(s, r)));
            } catch (RuntimeException e) {
                LOG.warnf(e, "CivicOS SMTP check could not run");
            }
        });
    }

    static void check(org.keycloak.models.KeycloakSession s, RealmModel realm) {
        Map<String, String> c = realm.getSmtpConfig();
        if (c == null || c.get("host") == null || c.get("host").isBlank()) return;
        String host = c.get("host");
        boolean ssl = "true".equals(c.get("ssl"));
        int port = parsePort(c.get("port"), ssl ? 465 : 25);
        boolean auth = "true".equals(c.get("auth"));
        Properties p = new Properties();
        String proto = ssl ? "smtps" : "smtp";
        p.put("mail." + proto + ".host", host);
        p.put("mail." + proto + ".port", Integer.toString(port));
        p.put("mail." + proto + ".auth", Boolean.toString(auth));
        p.put("mail." + proto + ".starttls.enable", Boolean.toString("true".equals(c.get("starttls"))));
        p.put("mail." + proto + ".connectiontimeout", "10000");
        p.put("mail." + proto + ".timeout", "10000");
        try {
            Transport t = Session.getInstance(p).getTransport(proto);
            String user = auth ? c.get("user") : null;
            String password = auth ? secret(s, c.get("password")) : null;
            if (auth && (user == null || user.isBlank() || user.startsWith("${") || password == null || password.isBlank() || password.startsWith("${"))) {
                LOG.errorf("CivicOS SMTP check FAILED for realm %s: %s:%d needs a user and password, and they are not set", realm.getName(), host, port);
                return;
            }
            t.connect(host, port, user, password);
            t.close();
            LOG.infof("CivicOS SMTP check: realm %s can reach %s:%d%s", realm.getName(), host, port, auth ? " and log in" : "");
        } catch (Exception e) {
            LOG.errorf("CivicOS SMTP check FAILED for realm %s: %s:%d: %s", realm.getName(), host, port, e.getMessage());
        }
    }

    static int parsePort(String raw, int dflt) {
        try { return raw == null || raw.isBlank() ? dflt : Integer.parseInt(raw.trim()); } catch (NumberFormatException e) { return dflt; }
    }

    private static String secret(org.keycloak.models.KeycloakSession s, String raw) {
        if (raw == null) return null;
        try {
            return s.vault().getStringSecret(raw).get().orElse(raw);
        } catch (RuntimeException e) {
            return raw;
        }
    }
}
