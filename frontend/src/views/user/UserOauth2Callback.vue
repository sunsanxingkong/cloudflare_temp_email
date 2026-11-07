<script setup>
import { ref, onMounted } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { useRoute, useRouter } from 'vue-router';

import { useGlobalState } from '../../store'
import { api } from '../../api';

const {
    userJwt, userTab, userOauth2SessionState, userOauth2SessionClientID, userOauth2SessionMode
} = useGlobalState()

const message = useMessage();
const route = useRoute()
const router = useRouter()
const errorInfo = ref('')
const linkConfirmation = ref(null)
const confirmingLink = ref(false)
const { t } = useScopedI18n('views.user.UserOauth2Callback')

const confirmLegacyOAuthLink = async () => {
    if (!linkConfirmation.value?.pendingToken) return
    confirmingLink.value = true
    try {
        const res = await api.fetch('/user_api/oauth2/legacy-link/confirm', {
            method: 'POST',
            body: JSON.stringify({ pendingToken: linkConfirmation.value.pendingToken }),
        })
        userJwt.value = res.jwt
        userTab.value = 'user_settings'
        message.success(t('identityLinked'))
        router.push('/user')
    } catch (error) {
        console.error(error)
        errorInfo.value = error.message || 'error'
        message.error(error.message || 'error')
    } finally {
        confirmingLink.value = false
    }
}

onMounted(async () => {
    try {
        const queryValue = (value) => Array.isArray(value) ? value[0] : value;
        const state = queryValue(route.query.state);
        if (!state || state !== userOauth2SessionState.value) {
            console.error('state not match');
            message.error(t('stateNotMatch'));
            errorInfo.value = t('stateNotMatch');
            return;
        }
        const code = queryValue(route.query.code);
        if (!code) {
            console.error('code not found');
            message.error(t('codeNotFound'));
            errorInfo.value = t('codeNotFound');
            return;
        }
        if (userOauth2SessionMode.value === 'link') {
            await api.fetch('/user_api/oauth2/link/complete', {
                method: 'POST',
                body: JSON.stringify({
                    code,
                    clientID: userOauth2SessionClientID.value,
                    state,
                }),
            });
            message.success(t('identityLinked'));
            userTab.value = 'user_settings';
            router.push('/user');
            return;
        }
        const res = await api.fetch(`/user_api/oauth2/callback`, {
            method: 'POST',
            body: JSON.stringify({
                code: code,
                clientID: userOauth2SessionClientID.value
            })
        });
        if (res.linkRequired) {
            linkConfirmation.value = res
            return
        }
        userJwt.value = res.jwt;
        router.push('/user');
    } catch (error) {
        console.error(error);
        errorInfo.value = error.message || 'error';
        message.error(error.message || 'error');
    } finally {
        userOauth2SessionState.value = '';
        userOauth2SessionClientID.value = '';
        userOauth2SessionMode.value = 'login';
    }
});
</script>

<template>
    <n-card v-if="linkConfirmation" :bordered="false" embedded>
        <n-result status="warning" :title="t('linkConfirmTitle')" :description="t('linkConfirmDescription')" />
        <div class="link-confirm-summary">
            <n-tag type="info">{{ linkConfirmation.providerName }} · {{ linkConfirmation.maskedEmail }}</n-tag>
        </div>
        <n-button type="primary" :loading="confirmingLink" @click="confirmLegacyOAuthLink">
            {{ t('confirmLink') }}
        </n-button>
    </n-card>
    <n-card v-else :bordered="false" embedded>
        <n-result status="info" :title="t('logging')" :description="errorInfo">
        </n-result>
    </n-card>
</template>

<style scoped>
.link-confirm-summary {
    margin: 16px 0;
}
</style>
