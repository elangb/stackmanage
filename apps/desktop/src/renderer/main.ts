import { createApp } from 'vue';
import { createStackManageI18n } from '@stackmanage/i18n';
import '@stackmanage/ui/theme.css';
import App from './App.vue';

createApp(App).use(createStackManageI18n()).mount('#app');
