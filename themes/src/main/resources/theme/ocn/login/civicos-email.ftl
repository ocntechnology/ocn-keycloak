<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<@layout.registrationLayout displayMessage=true; section>
<!-- template: civicos-email.ftl (CivicOS sign-in policy) -->
    <#if section = "header">
        ${msg("civicosSignInTitle")}
    <#elseif section = "form">
        <form id="civicos-email-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post" novalidate>
            <div class="${properties.kcFormGroupClass!}">
                <div class="${properties.kcFormGroupLabelClass!}">
                    <label for="email" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicosEmailLabel")}</span></label>
                </div>
                <p id="email-hint" class="civicos-hint">${msg("civicosEmailHint")}</p>
                <span class="${properties.kcInputClass!} <#if message?? && message.type = 'error'>${properties.kcError!}</#if>">
                    <input id="email" name="email" type="email" value="${civicosEmailValue!''}" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus
                           aria-describedby="email-hint" <#if message?? && message.type = 'error'>aria-invalid="true"</#if> />
                </span>
            </div>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-continue" name="continue" type="submit">${msg("civicosContinue")}</button>
            </@buttons.actionGroup>
        </form>
    <#elseif section = "info">
        <p class="civicos-small">${msg("civicosEmailInfo")}</p>
    </#if>
</@layout.registrationLayout>
