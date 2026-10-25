<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true; section>
<!-- template: civicos-password.ftl (CivicOS sign-in policy) -->
    <#if section = "header">
        ${msg("civicosPasswordTitle")}
    <#elseif section = "form">
        <p class="civicos-signed-as">${msg("civicosSigningInAs")} <strong>${civicosEmail}</strong><#if civicosOrgName??> (${civicosOrgName})</#if></p>
        <form id="civicos-password-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <input type="hidden" name="username" value="${civicosEmail}" autocomplete="username" />
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="password" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("password")}</span></label>
                </div>
                <span class="${properties.kcInputClass!} <#if message?? && message.type = 'error'>${properties.kcError!}</#if>">
                    <input id="password" name="password" type="password" autocomplete="current-password" autofocus <#if message?? && message.type = 'error'>aria-invalid="true"</#if> />
                </span>
            </div>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-sign-in" name="login" type="submit">${msg("civicosSignIn")}</button>
                <button class="${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-use-code" name="useCode" value="1" type="submit" formnovalidate>${msg("civicosEmailMeACode")}</button>
            </@buttons.actionGroup>
            <p class="civicos-small"><a href="${url.loginResetCredentialsUrl}">${msg("civicosForgotPassword")}</a></p>
            <button class="civicos-link" name="restart" value="1" type="submit" formnovalidate>${msg("civicosDifferentEmail")}</button>
        </form>
    </#if>
</@layout.registrationLayout>
