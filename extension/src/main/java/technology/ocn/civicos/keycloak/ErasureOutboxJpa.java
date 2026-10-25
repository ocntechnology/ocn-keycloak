package technology.ocn.civicos.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.connections.jpa.entityprovider.JpaEntityProvider;
import org.keycloak.connections.jpa.entityprovider.JpaEntityProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

/** Registers {@link ErasureOutboxEntity} and its Liquibase changelog with Keycloak's database. */
public class ErasureOutboxJpa implements JpaEntityProvider {
    public static final String ID = "civicos-erasure-outbox";

    @Override public List<Class<?>> getEntities() { return List.of(ErasureOutboxEntity.class); }
    @Override public String getChangelogLocation() { return "META-INF/civicos-erasure-outbox-changelog.xml"; }
    @Override public String getFactoryId() { return ID; }
    @Override public void close() { }

    public static class Factory implements JpaEntityProviderFactory {
        @Override public JpaEntityProvider create(KeycloakSession session) { return new ErasureOutboxJpa(); }
        @Override public void init(Config.Scope config) { }
        @Override public void postInit(KeycloakSessionFactory factory) { }
        @Override public void close() { }
        @Override public String getId() { return ID; }
    }
}
