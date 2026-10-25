<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true; section>
<!-- template: civicos-choose.ftl (CivicOS sign-in policy) -->
    <#if section = "header">
        ${msg("civicosChooseTitle")}
    <#elseif section = "form">
        <p class="civicos-signed-as">${msg("civicosSigningInAs")} <strong>${civicosEmail}</strong><#if civicosOrgName??> (${civicosOrgName})</#if></p>
        <form id="civicos-choose-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <@buttons.actionGroup>
                <#if civicosSsoName??>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-sso" name="method" value="sso" type="submit">${msg("civicosUseSso", civicosSsoName)}</button>
                </#if>
                <#if civicosOfferPassword>
                <button class="${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-use-password" name="method" value="password" type="submit">${msg("civicosUsePassword")}</button>
                </#if>
                <button class="${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-use-code" name="method" value="code" type="submit">${msg("civicosUseCode")}</button>
            </@buttons.actionGroup>
            <button class="civicos-link" name="restart" value="1" type="submit">${msg("civicosDifferentEmail")}</button>
        </form>
    </#if>
</@layout.registrationLayout>
