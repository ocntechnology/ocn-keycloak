package technology.ocn.civicos.keycloak;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.NamedQueries;
import jakarta.persistence.NamedQuery;
import jakarta.persistence.Table;

/**
 * One pending account-erasure notice for one product (table CIVICOS_ERASURE_OUTBOX in Keycloak's
 * database, created by META-INF/civicos-erasure-outbox-changelog.xml). Written in the same
 * transaction as the account deletion, so a notice is never lost to a restart; deleted once the
 * product has answered 2xx. The signed token is not stored: it is made fresh for each attempt.
 */
@Entity
@Table(name = "CIVICOS_ERASURE_OUTBOX")
@NamedQueries({
    @NamedQuery(name = "civicosErasureDue", query = "select e from ErasureOutboxEntity e where e.failed = false and e.nextAttempt <= :now order by e.nextAttempt"),
    @NamedQuery(name = "civicosErasureAll", query = "select e from ErasureOutboxEntity e where e.realmId = :realmId order by e.created"),
})
public class ErasureOutboxEntity {
    @Id @Column(name = "ID", length = 36) private String id;
    @Column(name = "REALM_ID", length = 36, nullable = false) private String realmId;
    @Column(name = "CLIENT_ID", length = 255, nullable = false) private String clientId;
    @Column(name = "URL", length = 1024, nullable = false) private String url;
    @Column(name = "USER_ID", length = 36, nullable = false) private String userId;
    @Column(name = "EMAIL", length = 255) private String email;
    @Column(name = "REASON", length = 255) private String reason;
    @Column(name = "ISSUER", length = 1024, nullable = false) private String issuer;
    @Column(name = "CREATED", nullable = false) private long created;
    @Column(name = "NEXT_ATTEMPT", nullable = false) private long nextAttempt;
    @Column(name = "ATTEMPTS", nullable = false) private int attempts;
    @Column(name = "FAILED", nullable = false) private boolean failed;
    @Column(name = "LAST_ERROR", length = 1024) private String lastError;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getRealmId() { return realmId; }
    public void setRealmId(String realmId) { this.realmId = realmId; }
    public String getClientId() { return clientId; }
    public void setClientId(String clientId) { this.clientId = clientId; }
    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
    public String getIssuer() { return issuer; }
    public void setIssuer(String issuer) { this.issuer = issuer; }
    public long getCreated() { return created; }
    public void setCreated(long created) { this.created = created; }
    public long getNextAttempt() { return nextAttempt; }
    public void setNextAttempt(long nextAttempt) { this.nextAttempt = nextAttempt; }
    public int getAttempts() { return attempts; }
    public void setAttempts(int attempts) { this.attempts = attempts; }
    public boolean isFailed() { return failed; }
    public void setFailed(boolean failed) { this.failed = failed; }
    public String getLastError() { return lastError; }
    public void setLastError(String lastError) { this.lastError = lastError; }
}
