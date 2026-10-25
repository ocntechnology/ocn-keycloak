package technology.ocn.civicos.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** ID-3 code limits, ID-5 session rules, ID-7 erasure back-off, ID-11 the one personal-domain list. */
class LimitsAndRulesTest {

    /** The single-use object store, with lifespans. */
    static final class FakeStore implements CodeLimits.Store {
        final Map<String, Map<String, String>> values = new HashMap<>();
        final Map<String, Long> expires = new HashMap<>();
        long now;
        public Map<String, String> get(String k) { Long e = expires.get(k); return e == null || e <= now ? null : values.get(k); }
        public void put(String k, long life, Map<String, String> v) { values.put(k, v); expires.put(k, now + life); }
        public void remove(String k) { values.remove(k); expires.remove(k); }
    }

    static final CodeLimits.Config C = CodeLimits.Config.DEFAULT;
    static final String R = "realm-1";

    @Test
    void codesAreCappedPerAddressIn15MinutesAndPerDay() {
        FakeStore s = new FakeStore();
        String a = "someone@towerhamlets.gov.uk";
        for (int i = 0; i < 3; i++) assertEquals(CodeLimits.Send.OK, CodeLimits.trySend(s, C, R, a, s.now += 60));
        assertEquals(CodeLimits.Send.CAPPED, CodeLimits.trySend(s, C, R, a, s.now += 60), "a fourth code within 15 minutes");
        assertEquals(CodeLimits.Send.OK, CodeLimits.trySend(s, C, R, "other@towerhamlets.gov.uk", s.now), "another address is not affected");
        assertEquals(CodeLimits.Send.CAPPED, CodeLimits.trySend(s, C, R, "SOMEONE@TowerHamlets.gov.uk ", s.now), "case and spaces do not get round it");
        // 3 every 16 minutes: the tenth code of the day is the last.
        int sent = 3;
        while (sent < 10) {
            s.now += 16 * 60;
            for (int i = 0; i < 3 && sent < 10; i++, sent++) assertEquals(CodeLimits.Send.OK, CodeLimits.trySend(s, C, R, a, s.now += 1));
        }
        s.now += 16 * 60;
        assertEquals(CodeLimits.Send.CAPPED, CodeLimits.trySend(s, C, R, a, s.now), "an eleventh code in a day");
        s.now += 24 * 3600;
        assertEquals(CodeLimits.Send.OK, CodeLimits.trySend(s, C, R, a, s.now), "a new day");
    }

    @Test
    void tenWrongCodesLockTheAddressFor15MinutesAndNewCodesDoNotResetTheCount() {
        FakeStore s = new FakeStore();
        String a = "chief.executive@hackney.gov.uk";
        for (int i = 1; i < 10; i++) {
            assertFalse(CodeLimits.wrong(s, C, R, a, s.now += 5));
            if (i % 5 == 0) assertEquals(CodeLimits.Send.OK, CodeLimits.trySend(s, C, R, a, s.now), "a new code");
        }
        assertTrue(CodeLimits.wrong(s, C, R, a, s.now += 5), "the tenth wrong code locks");
        assertTrue(CodeLimits.locked(s, R, a, s.now));
        assertEquals(CodeLimits.Send.LOCKED, CodeLimits.trySend(s, C, R, a, s.now));
        s.now += 15 * 60 + 1;
        assertFalse(CodeLimits.locked(s, R, a, s.now), "unlocked after 15 minutes");
        CodeLimits.wrong(s, C, R, a, s.now);
        CodeLimits.succeeded(s, R, a);
        for (int i = 1; i < 10; i++) assertFalse(CodeLimits.wrong(s, C, R, a, s.now), "a right code starts the count again");
        CodeLimits.reset(s, R, a);
        assertFalse(CodeLimits.locked(s, R, a, s.now));
    }

    @Test
    void storeKeysNeverHoldTheAddress() {
        String k = CodeLimits.key(R, "sent", "someone@towerhamlets.gov.uk");
        assertFalse(k.contains("someone"));
        assertEquals(CodeLimits.key(R, "sent", "Someone@TowerHamlets.gov.uk"), k);
        assertFalse(CodeLimits.key("realm-2", "sent", "someone@towerhamlets.gov.uk").equals(k), "per realm");
    }

    static final long H12 = 12 * 3600;
    static final long D30 = 30L * 24 * 3600;

    @Test
    void refreshRules() {
        long now = 2_000_000_000L;
        String fresh = Instant.ofEpochSecond(now).minus(Duration.ofDays(1)).toString();
        String stale = Instant.ofEpochSecond(now).minus(Duration.ofDays(31)).toString();
        assertNull(SessionRules.refusal("sso", now - H12 + 60, now, SignInPolicy.SSO_REQUIRED, null, H12, D30), "SSO under 12 hours");
        assertNotNull(SessionRules.refusal("sso", now - H12 - 60, now, SignInPolicy.OPEN, fresh, H12, D30), "(a) SSO over 12 hours");
        assertNotNull(SessionRules.refusal("password", now - 60, now, SignInPolicy.SSO_REQUIRED, fresh, H12, D30), "(b) SSO now required");
        assertNotNull(SessionRules.refusal(null, now - 60, now, SignInPolicy.SSO_REQUIRED, fresh, H12, D30), "(b) no method recorded counts as password");
        assertNotNull(SessionRules.refusal("email_code", now - 60, now, SignInPolicy.OPEN, stale, H12, D30), "(c) mailbox check over 30 days");
        assertNotNull(SessionRules.refusal("password", now - 60, now, SignInPolicy.OPEN, null, H12, D30), "(c) never checked");
        assertNull(SessionRules.refusal("password", now - 20 * 86400, now, SignInPolicy.SSO_AVAILABLE, fresh, H12, D30), "a 20-day password session with a recent check");
        assertNull(SessionRules.refusal("sso", now - 60, now, SignInPolicy.OPEN, stale, H12, D30), "SSO sessions do not need the mailbox check");
        assertNotNull(SessionRules.refusal("password", now - 60, now, SignInPolicy.OPEN, Instant.ofEpochSecond(now - 10).toString(), H12, 5), "a shorter realm limit");
    }

    @Test
    void erasureBackOffRunsForAtLeastADay() {
        assertEquals(60, ErasureOutbox.backoff(60, 1));
        assertEquals(240, ErasureOutbox.backoff(60, 2));
        assertEquals(960, ErasureOutbox.backoff(60, 3));
        assertEquals(4 * 3600, ErasureOutbox.backoff(60, 9), "at most 4 hours apart");
        long t = 0;
        int attempts = 0;
        while (!ErasureOutbox.givenUp(0, t)) t += ErasureOutbox.backoff(60, ++attempts);
        assertTrue(t >= 24 * 3600, "retries for at least 24 hours");
        assertTrue(attempts >= 8, "several tries, got " + attempts);
    }

    @Test
    void personalDomainsComeFromTheSharedList() throws Exception {
        for (String d : new String[] {"gmail.com", "protonmail.ch", "mail.ru", "qq.com", "web.de", "gmx.de", "yahoo.fr", "hotmail.de", "outlook.com.au", "ymail.com"}) {
            assertTrue(EmailDomains.isPersonal("someone@" + d), d);
        }
        for (String d : new String[] {"towerhamlets.gov.uk", "local.gov.uk", "ocn.technology", "nhs.net", "mail.gov.uk"}) {
            assertFalse(EmailDomains.isPersonal("someone@" + d), d);
        }
        assertTrue(EmailDomains.PERSONAL.size() > 100);
        // The packaged copy is the file in src/main/resources, byte for byte.
        try (InputStream in = EmailDomains.class.getResourceAsStream(EmailDomains.RESOURCE)) {
            byte[] packaged = in.readAllBytes();
            byte[] source = Files.readAllBytes(Path.of("src/main/resources/personal-email-domains.json"));
            assertEquals(new String(source), new String(packaged));
        }
    }

    @Test
    void ssoButtonNamesDropTheJargon() {
        assertEquals("Kingston Council", CivicosSignInAuthenticator.ssoName("Kingston Council SSO"));
        assertEquals("Hackney Microsoft 365", CivicosSignInAuthenticator.ssoName("Hackney Microsoft 365"));
        assertEquals("Camden", CivicosSignInAuthenticator.ssoName("Camden single sign-on"));
    }
}
