<#import "template.ftl" as layout>
<#import "buttons.ftl" as buttons>
<#-- CivicOS first sign-in: the person adds their name. The email is shown as text: it is the
     address they proved with a code and only an administrator can change it. -->
<@layout.registrationLayout displayMessage=messagesPerField.exists('global') displayRequiredFields=false; section>
<!-- template: login-update-profile.ftl (CivicOS) -->
    <#if section = "header">
        ${msg("loginProfileTitle")}
    <#elseif section = "form">
        <#assign emailValue = (profile.attributesByName.email.value)!"">
        <p class="civicos-signed-as">${msg("civicosProfileEmail")} <strong id="civicos-profile-email">${emailValue}</strong></p>
        <form id="kc-update-profile-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <#list ["firstName", "lastName"] as name>
                <#assign attr = (profile.attributesByName[name])!>
                <#if attr?has_content>
                <div class="${properties.kcFormGroupClass!}">
                    <div class="${properties.kcFormGroupLabelClass!}">
                        <label for="${name}" class="${properties.kcFormLabelClass!}"><span class="${properties.kcFormLabelTextClass!}">${msg("civicos_" + name)}</span></label>
                    </div>
                    <span class="${properties.kcInputClass!} <#if messagesPerField.existsError(name)>${properties.kcError!}</#if>">
                        <input id="${name}" name="${name}" type="text" value="${(attr.value)!''}" autocomplete="<#if name = 'firstName'>given-name<#else>family-name</#if>"
                               <#if name = 'firstName'>autofocus</#if> <#if messagesPerField.existsError(name)>aria-invalid="true" aria-describedby="input-error-${name}"</#if> />
                    </span>
                    <#if messagesPerField.existsError(name)>
                        <span id="input-error-${name}" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">${kcSanitize(messagesPerField.get(name))?no_esc}</span>
                    </#if>
                </div>
                </#if>
            </#list>
            <@buttons.actionGroup>
                <button class="${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" id="civicos-profile-save" type="submit">${msg("civicosContinue")}</button>
            </@buttons.actionGroup>
        </form>
    </#if>
</@layout.registrationLayout>
