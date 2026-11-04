import { createI18n } from 'vue-i18n';

const en = {
  brand: 'StackManage', language: 'Language', phase: 'PHASE 0 · FOUNDATION',
  title: 'Your local workspace starts here.',
  intro: 'The desktop shell and isolated worker are ready for development. Runtime installation, services, sites and plugins are not implemented yet.',
  healthTitle: 'Application connection', check: 'Check worker', idle: 'Connection not checked', pending: 'Checking the worker…', ready: 'Worker responded successfully', failed: 'Worker unavailable. Try again.',
  policyTitle: 'Workspace principles', licensing: 'Product licensing', unlimited: 'Unlimited', telemetry: 'Telemetry', off: 'Off',
  footer: 'Development preview. Platform and feature acceptance remains unverified.',
  locales: { en: 'English', id: 'Bahasa Indonesia', zh: '简体中文', es: 'Español', vi: 'Tiếng Việt' }
};
type Messages = typeof en;
export const messages: Record<'en' | 'id' | 'zh' | 'es' | 'vi', Messages> = {
  en,
  id: { brand: 'StackManage', language: 'Bahasa', phase: 'FASE 0 · FONDASI', title: 'Ruang kerja lokal Anda dimulai di sini.', intro: 'Kerangka desktop dan worker terisolasi siap dikembangkan. Instalasi runtime, layanan, situs, dan plugin belum diimplementasikan.', healthTitle: 'Koneksi aplikasi', check: 'Periksa worker', idle: 'Koneksi belum diperiksa', pending: 'Memeriksa worker…', ready: 'Worker berhasil merespons', failed: 'Worker tidak tersedia. Coba lagi.', policyTitle: 'Prinsip ruang kerja', licensing: 'Lisensi produk', unlimited: 'Tanpa batas', telemetry: 'Telemetri', off: 'Nonaktif', footer: 'Pratinjau pengembangan. Penerimaan platform dan fitur belum terverifikasi.', locales: en.locales },
  zh: { brand: 'StackManage', language: '语言', phase: '阶段 0 · 基础', title: '从这里开始您的本地工作空间。', intro: '桌面框架和隔离工作进程已可用于开发。运行时安装、服务、站点和插件尚未实现。', healthTitle: '应用连接', check: '检查工作进程', idle: '尚未检查连接', pending: '正在检查工作进程…', ready: '工作进程响应成功', failed: '工作进程不可用，请重试。', policyTitle: '工作空间原则', licensing: '产品许可', unlimited: '无限制', telemetry: '遥测', off: '关闭', footer: '开发预览。平台和功能验收尚未验证。', locales: en.locales },
  es: { brand: 'StackManage', language: 'Idioma', phase: 'FASE 0 · BASE', title: 'Tu espacio de trabajo local empieza aquí.', intro: 'La estructura de escritorio y el proceso aislado están listos para el desarrollo. La instalación de runtimes, los servicios, los sitios y los plugins aún no están implementados.', healthTitle: 'Conexión de la aplicación', check: 'Comprobar proceso', idle: 'Conexión sin comprobar', pending: 'Comprobando el proceso…', ready: 'El proceso respondió correctamente', failed: 'Proceso no disponible. Inténtalo de nuevo.', policyTitle: 'Principios del espacio de trabajo', licensing: 'Licencia del producto', unlimited: 'Sin límites', telemetry: 'Telemetría', off: 'Desactivada', footer: 'Vista previa de desarrollo. La aceptación de plataformas y funciones sigue sin verificarse.', locales: en.locales },
  vi: { brand: 'StackManage', language: 'Ngôn ngữ', phase: 'GIAI ĐOẠN 0 · NỀN TẢNG', title: 'Không gian làm việc cục bộ bắt đầu tại đây.', intro: 'Khung ứng dụng máy tính và tiến trình độc lập đã sẵn sàng để phát triển. Cài đặt runtime, dịch vụ, trang web và plugin chưa được triển khai.', healthTitle: 'Kết nối ứng dụng', check: 'Kiểm tra tiến trình', idle: 'Chưa kiểm tra kết nối', pending: 'Đang kiểm tra tiến trình…', ready: 'Tiến trình đã phản hồi thành công', failed: 'Tiến trình không khả dụng. Hãy thử lại.', policyTitle: 'Nguyên tắc không gian làm việc', licensing: 'Giấy phép sản phẩm', unlimited: 'Không giới hạn', telemetry: 'Đo từ xa', off: 'Tắt', footer: 'Bản xem trước phát triển. Chưa xác minh nghiệm thu nền tảng và tính năng.', locales: en.locales }
};
export type Locale = keyof typeof messages;
export const locales = Object.keys(messages) as Locale[];
export function createStackManageI18n() { return createI18n({ legacy: false, locale: 'id', fallbackLocale: 'en', messages }); }
