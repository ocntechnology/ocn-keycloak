package technology.ocn.civicos.keycloak;

import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;

/** Sends the six-digit code through the realm's SMTP settings. */
public final class CodeMailer {
    private CodeMailer() {}

    public static String subject(boolean mailboxCheck) {
        return mailboxCheck ? "Confirm your email for CivicOS" : "Your CivicOS sign-in code";
    }

    public static String text(String code, boolean mailboxCheck) {
        String lead = mailboxCheck
            ? "Every 30 days we check that you still have this mailbox. Enter this code to carry on signing in to CivicOS:"
            : "Enter this code to sign in to CivicOS:";
        return lead + "\n\n" + code + "\n\nThe code works for 10 minutes. If you did not try to sign in, you can ignore this email.\n\nCivicOS, from OCN Technology\n";
    }

    public static String html(String code, boolean mailboxCheck) {
        String lead = mailboxCheck
            ? "Every 30 days we check that you still have this mailbox. Enter this code to carry on signing in to CivicOS:"
            : "Enter this code to sign in to CivicOS:";
        return "<!doctype html><html lang=\"en-GB\"><body style=\"font-family:Arial,sans-serif;color:#15181C;font-size:16px;line-height:1.5\">"
            + "<p>" + lead + "</p>"
            + "<p style=\"font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0\">" + code + "</p>"
            + "<p>The code works for 10 minutes. If you did not try to sign in, you can ignore this email.</p>"
            + "<p style=\"color:#555\">CivicOS, from OCN Technology</p></body></html>";
    }

    public static void send(KeycloakSession session, RealmModel realm, String to, String code, boolean mailboxCheck) throws EmailException {
        EmailSenderProvider sender = session.getProvider(EmailSenderProvider.class);
        sender.send(realm.getSmtpConfig(), to, subject(mailboxCheck), text(code, mailboxCheck), html(code, mailboxCheck));
    }
}
