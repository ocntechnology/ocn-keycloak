package technology.ocn.civicos.keycloak;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PolicyLogicTest {

    static final OrgPolicy OPEN = OrgPolicy.combine(List.of(new OrgPolicy.Org("hackney", SignInPolicy.OPEN, false, List.of())));
    static final OrgPolicy AVAILABLE = OrgPolicy.combine(List.of(new OrgPolicy.Org("kingston", SignInPolicy.SSO_AVAILABLE, false, List.of("kingston-sso"))));
    static final OrgPolicy REQUIRED = OrgPolicy.combine(List.of(new OrgPolicy.Org("kingston", SignInPolicy.SSO_REQUIRED, false, List.of("kingston-sso"))));

    @Test void emailNormalisedAndValidated() {
        assertEquals("officer@kingston.gov.uk", EmailDomains.normalise("  Officer@Kingston.GOV.uk "));
        assertNull(EmailDomains.normalise("not an email"));
        assertNull(EmailDomains.normalise("a@b"));
        assertNull(EmailDomains.normalise(null));
        assertEquals("hackney.gov.uk", EmailDomains.domainOf("a@hackney.gov.uk"));
    }

    @Test void personalDomainsRefused() {
        for (String e : List.of("x@gmail.com", "x@googlemail.com", "x@yahoo.co.uk", "x@yahoo.fr", "x@hotmail.co.uk", "x@outlook.com", "x@icloud.com", "x@btinternet.com", "x@proton.me"))
            assertTrue(EmailDomains.isPersonal(e), e);
        for (String e : List.of("x@hackney.gov.uk", "x@local.gov.uk", "x@ocn.technology", "x@nhs.net", "x@londoncouncils.gov.uk"))
            assertFalse(EmailDomains.isPersonal(e), e);
    }

    @Test void routes() {
        assertEquals(Route.Kind.INVALID_EMAIL, Route.decide(null, OrgPolicy.NONE, false, false, false).kind);
        assertEquals(Route.Kind.PERSONAL_EMAIL, Route.decide("a@gmail.com", OrgPolicy.NONE, true, true, true).kind, "personal refused even if an account exists");
        assertEquals(Route.Kind.UNKNOWN_DOMAIN, Route.decide("a@unknown.example", OrgPolicy.NONE, false, false, false).kind);
        assertEquals(Route.Kind.CODE, Route.decide("a@unknown.example", OrgPolicy.NONE, true, true, false).kind, "invited guest at an unregistered work domain");
        assertEquals(Route.Kind.PASSWORD, Route.decide("a@unknown.example", OrgPolicy.NONE, true, true, true).kind);
        assertEquals(Route.Kind.ACCOUNT_DISABLED, Route.decide("a@hackney.gov.uk", OPEN, true, false, true).kind);
        assertEquals(Route.Kind.CODE, Route.decide("new@hackney.gov.uk", OPEN, false, false, false).kind, "first sign-in at a registered council");
        assertEquals(Route.Kind.PASSWORD, Route.decide("a@hackney.gov.uk", OPEN, true, true, true).kind);
        Route choose = Route.decide("a@kingston.gov.uk", AVAILABLE, true, true, true);
        assertEquals(Route.Kind.CHOOSE, choose.kind);
        assertEquals("kingston-sso", choose.idpAlias);
        assertTrue(choose.offerPassword);
        assertFalse(Route.decide("new@kingston.gov.uk", AVAILABLE, false, false, false).offerPassword);
        Route sso = Route.decide("a@kingston.gov.uk", REQUIRED, true, true, true);
        assertEquals(Route.Kind.SSO_REDIRECT, sso.kind);
        assertEquals("kingston-sso", sso.idpAlias);
        OrgPolicy requiredNoIdp = OrgPolicy.combine(List.of(new OrgPolicy.Org("x", SignInPolicy.SSO_REQUIRED, false, List.of())));
        assertEquals(Route.Kind.SSO_NOT_CONNECTED, Route.decide("a@x.gov.uk", requiredNoIdp, true, true, true).kind);
        OrgPolicy availableNoIdp = OrgPolicy.combine(List.of(new OrgPolicy.Org("x", SignInPolicy.SSO_AVAILABLE, false, List.of())));
        assertEquals(Route.Kind.PASSWORD, Route.decide("a@x.gov.uk", availableNoIdp, true, true, true).kind);
    }

    @Test void sharedDomainTakesStrictestPolicy() {
        OrgPolicy shared = OrgPolicy.combine(List.of(
            new OrgPolicy.Org("richmond", SignInPolicy.OPEN, false, List.of()),
            new OrgPolicy.Org("wandsworth", SignInPolicy.SSO_AVAILABLE, true, List.of("wandsworth-sso"))));
        assertEquals(SignInPolicy.SSO_AVAILABLE, shared.policy());
        assertTrue(shared.requireSecondFactor());
        assertNull(shared.singleAlias());
        assertEquals(List.of("richmond", "wandsworth"), shared.aliases());
        assertEquals(SignInPolicy.SSO_REQUIRED, SignInPolicy.parse("sso-required"));
        assertEquals(SignInPolicy.OPEN, SignInPolicy.parse("nonsense"));
    }

    static EmailCode.Notes map() {
        Map<String, String> m = new HashMap<>();
        return new EmailCode.Notes() {
            public String get(String k) { return m.get(k); }
            public void set(String k, String v) { m.put(k, v); }
            public void remove(String k) { m.remove(k); }
        };
    }

    @Test void emailCodeIsSixDigitsAndVerifiesOnce() {
        EmailCode.Notes n = map();
        String code = EmailCode.issue(n, 1000);
        assertTrue(code.matches("\\d{6}"));
        assertNotEquals(code, n.get(EmailCode.N_HASH), "only a hash is stored");
        assertEquals(EmailCode.Result.OK, EmailCode.verify(n, code.substring(0, 3) + " " + code.substring(3), 1001));
        assertEquals(EmailCode.Result.NO_CODE, EmailCode.verify(n, code, 1002), "single use");
    }

    @Test void emailCodeExpiresAfterTenMinutes() {
        EmailCode.Notes n = map();
        String code = EmailCode.issue(n, 1000);
        assertEquals(EmailCode.Result.EXPIRED, EmailCode.verify(n, code, 1000 + 601));
        String code2 = EmailCode.issue(n, 2000);
        assertEquals(EmailCode.Result.OK, EmailCode.verify(n, code2, 2000 + 600));
    }

    @Test void emailCodeAllowsFiveAttempts() {
        EmailCode.Notes n = map();
        String code = EmailCode.issue(n, 0);
        String wrong = code.equals("000000") ? "111111" : "000000";
        for (int i = 0; i < 4; i++) assertEquals(EmailCode.Result.WRONG, EmailCode.verify(n, wrong, 1));
        assertEquals(1, EmailCode.attemptsLeft(n));
        assertEquals(EmailCode.Result.TOO_MANY_ATTEMPTS, EmailCode.verify(n, wrong, 1));
        assertEquals(EmailCode.Result.NO_CODE, EmailCode.verify(n, code, 1), "the right code no longer works after 5 wrong ones");
    }

    @Test void resendIsRateLimited() {
        EmailCode.Notes n = map();
        EmailCode.issue(n, 100);
        assertFalse(EmailCode.canResend(n, 120));
        assertTrue(EmailCode.canResend(n, 130));
    }

    @Test void mailboxCheckEvery30Days() {
        Instant now = Instant.parse("2026-10-25T10:00:00Z");
        assertTrue(MailboxCheck.due(null, now));
        assertTrue(MailboxCheck.due("garbage", now));
        assertFalse(MailboxCheck.due(now.minus(Duration.ofDays(29)).toString(), now));
        assertFalse(MailboxCheck.due(now.minus(Duration.ofDays(30)).toString(), now));
        assertTrue(MailboxCheck.due(now.minus(Duration.ofDays(31)).toString(), now));
    }

    @Test void assuranceLevels() {
        assertEquals(2, Assurance.level("sso", false));
        assertEquals(2, Assurance.level("password", true));
        assertEquals(1, Assurance.level("password", false));
        assertEquals(1, Assurance.level("email_code", false));
        assertTrue(Assurance.needsSecondFactor("password", true, -1, false), "org requires a second step for passwords");
        assertFalse(Assurance.needsSecondFactor("email_code", true, -1, false), "the org rule is for password sign-ins");
        assertTrue(Assurance.needsSecondFactor("email_code", false, 2, false), "client asked for level 2");
        assertFalse(Assurance.needsSecondFactor("sso", true, 2, false), "SSO is already level 2");
        assertTrue(Assurance.needsSecondFactor("password", false, -1, true), "someone with an authenticator app is always asked");
    }

    @Test void staffAlwaysUseASecondStep() {
        assertTrue(Assurance.needsSecondFactor("password", false, -1, false, true), "OCN staff, password");
        assertTrue(Assurance.needsSecondFactor("email_code", false, -1, false, true), "OCN staff, email code");
        assertFalse(Assurance.needsSecondFactor("sso", false, -1, false, true), "SSO is already level 2");
        assertFalse(Assurance.needsSecondFactor("password", false, -1, false, false), "not staff, nothing asked");
    }

    @Test void erasureUserIdFromAdminEventPath() {
        assertEquals("1b2c", ErasureEventListener.userIdFromPath("users/1b2c"));
        assertNull(ErasureEventListener.userIdFromPath("users/1b2c/role-mappings"));
        assertNull(ErasureEventListener.userIdFromPath("clients/1b2c"));
        assertNull(ErasureEventListener.userIdFromPath(null));
    }

    @Test void codeEmailWording() {
        assertTrue(CodeMailer.text("123456", false).contains("123456"));
        assertTrue(CodeMailer.text("123456", true).contains("30 days"));
        assertFalse(CodeMailer.html("123456", false).contains("—"), "no em dashes");
    }
}
