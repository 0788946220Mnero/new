# Free Menu Platform — Backend

منصة منيو رقمي مجاني متعددة المطاعم: باك إند واحد، وقاعدة MongoDB مستقلة لكل مطعم، وقاعدة `restaurant_registry` مركزية تربط كل مطعم بقاعدته.

## الحالة الحالية

- ✅ المرحلة 1: هيكل المشروع، الإعدادات، السجلات، معالجة الأخطاء، الأمان الأساسي
- ✅ المرحلة 2: الاتصال بـ Atlas، الـ registry، و`TenantDatabaseManager`
- ✅ المرحلة 3: دخول السوبر أدمن (MFA إلزامي) + إنشاء المطاعم تلقائياً + إدارتها (API)
- ✅ لوحة السوبر أدمن: مشروع `super-admin` المنفصل
- ✅ المرحلة 4: دخول أصحاب المطاعم والموظفين، رابط تعيين كلمة المرور، الجلسات، الصلاحيات
- ✅ المرحلتان 6–7: الأصناف والمنتجات + لوحة المطعم (مشروع `restaurant-dashboard`)
- ✅ المراحل 8–10: الصور، وإعدادات المطعم والمظهر، والمنيو العام، ورمز QR (في لوحة المطعم)
- ✅ الأمان والنشر: انظر `SECURITY.md` و`DEPLOYMENT.md`

## التشغيل

```bash
npm install
cp .env.example .env      # ثم املأ القيم
npm run db:check          # يتحقق من Atlas وينشئ collections وفهارس الـ registry
npm run seed:super-admin  # ينشئ ninja@mero.com من SUPER_ADMIN_PASSWORD (لا يغيّر حساباً موجوداً)
npm run dev
npm test
```

### الاختبارات

- اختبارات الوحدة لا تحتاج قاعدة بيانات.
- اختبارات التكامل (`tests/integration`) تعمل على MongoDB حقيقي:
  - افتراضياً تشغّل MongoDB في الذاكرة عبر `mongodb-memory-server`. أول تشغيل ينزّل MongoDB مرة واحدة (يحتاج إنترنت).
  - أو `TEST_MONGODB_URI` لقاعدة اختبار. **لا تضعه أبداً على قاعدة الإنتاج.**
  - لتخطيها: `$env:SKIP_DB_TESTS=1; npm test` (PowerShell).

### استرجاع حساب السوبر أدمن

```bash
npm run seed:super-admin -- --reset-password   # يعيد كلمة المرور من .env ويطلب تغييرها
npm run seed:super-admin -- --reset-mfa        # عند فقدان الهاتف: تسجيل MFA من جديد
```
كلاهما يُخرج كل الجلسات. بعد الاستخدام احذف `SUPER_ADMIN_PASSWORD` من `.env`.

توليد الأسرار (كل واحد مختلف):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### مستخدم Atlas

قواعد المطاعم تُنشأ تلقائياً، لذلك يحتاج مستخدم قاعدة البيانات دور **readWriteAnyDatabase**.
لا تستخدم حساب `atlasAdmin` للتطبيق.

## كيف يُحدَّد المطعم

```
طلب لوحة التحكم:  token → restaurantId → registry → databaseName → useDb (مخزّن)
طلب المنيو العام:  /:slug → registry → databaseName → useDb (مخزّن)
```

- `restaurantId` و`databaseName` و`clusterId` تُحذف من body وquery في كل طلب، ولا تُقرأ من العميل أبداً.
- اسم القاعدة يُشتق من `restaurantId` فقط (`rest_XXXXXXXX` → `restaurant_XXXXXXXX`). إذا كان سجل الـ registry يشير لقاعدة أخرى يُرفض الطلب.
- المطعم الموقوف أو المؤرشف يعيد 403، والذي لم يكتمل إنشاؤه أو غير الموجود يعيد 404.
- التوجيه مخزّن مؤقتاً (30 ثانية افتراضياً). عند تغيير حالة المطعم أو الـ slug يجب استدعاء `tenantManager.invalidate(restaurantId)`.
- اتصال واحد لكل عنقود. عنقود إضافي لاحقاً: `MONGODB_URI__EU2=...` ثم `clusterId: "eu2"` في سجل المطعم.

## قاعدة كل مطعم (5 collections فقط)

`users` · `categories` · `products` · `settings` · `auditLogs`

## الـ registry

`restaurants` · `userDirectory` (إيميل ← مطعم، لتسجيل الدخول) · `platformUsers` · `platformSettings` · `platformAuditLogs`

## البنية

```
src/
  app.js                  تجميع Express (يُحقن بالاعتماديات، قابل للاختبار)
  server.js               الإقلاع والإغلاق الآمن
  config/env.js           التحقق من متغيرات البيئة
  config/database.js      اتصال واحد لكل عنقود
  registry/               نماذج وخدمة الـ registry
  tenants/                التسمية، نماذج المطعم، TenantDatabaseManager
  middleware/             العزل، الأخطاء
  routes/                 /health
scripts/check-db.js
tests/
```

## API السوبر أدمن (`/api/platform`)

كل الطلبات المحمية: `Authorization: Bearer <accessToken>`، ومدة التوكن 30 دقيقة.

| الطريقة | المسار | الوظيفة |
|---|---|---|
| POST | `/auth/login` | إيميل + كلمة مرور → `challengeToken` (+ `mfaSecret` في أول مرة) |
| POST | `/auth/mfa/setup` | أول مرة: `challengeToken` + كود التطبيق → توكن |
| POST | `/auth/mfa/verify` | كل مرة بعدها: `challengeToken` + كود → توكن |
| POST | `/auth/change-password` | إلزامي بعد أول دخول |
| POST | `/auth/logout` | يُخرج كل الجلسات |
| GET | `/auth/me` | |
| GET | `/stats` | عدد المطاعم حسب الحالة |
| GET | `/restaurants?q=&status=&page=&limit=` | قائمة وبحث |
| POST | `/restaurants` | إضافة مطعم (إنشاء كامل تلقائي) |
| GET | `/restaurants/:id` | تفاصيل + عدد الأصناف والمنتجات |
| PATCH | `/restaurants/:id` | name, slug, phone, email, address, notes, limits |
| POST | `/restaurants/:id/suspend` · `activate` · `archive` | تغيير الحالة (فوري) |
| POST | `/restaurants/:id/retry-provisioning` | إكمال إنشاء فشل |
| DELETE | `/restaurants/:id` | حذف مطعم **فشل إنشاؤه فقط** |
| POST | `/restaurants/:id/reset-owner-access` | رابط تعيين جديد للمالك، ويُلغى القديم |
| GET | `/audit-logs?restaurant=&action=` | سجل المنصة |

أي حقل غير معروف في الطلب يُرفض بـ 400، مثل `status` و`databaseName`.

### إضافة مطعم

```json
POST /api/platform/restaurants
{
  "name": "مطعم XYZ",
  "slug": "xyz-restaurant",
  "phone": "0790000000",
  "address": "عمّان",
  "owner": { "name": "أحمد", "email": "owner@xyz.com", "phone": "0790000001" }
}
```

`slug` اختياري: الاسم اللاتيني يتحول تلقائياً (`Burger House` → `burger-house`)، والاسم العربي يأخذ `menu-xxxxxxxx`.

الخطوات بالترتيب: `collections` → `owner` → `settings` → `media` → `audit` → `active`.
كل خطوة تُسجَّل. إذا فشلت إحداها تصبح الحالة `failed`، ويمكن بعدها **إعادة المحاولة** أو **الحذف**.

رابط المالك صالح 72 ساعة. التوكن فيه يأتي بعد `#` حتى لا يصل للسيرفر أو السجلات، ويُخزَّن في القاعدة مُشفَّراً باتجاه واحد (SHA-256).

## دخول المطاعم (`/api/auth`)

كل طلب POST يحتاج الترويسة `X-Requested-With: fetch` (حماية CSRF).

| الطريقة | المسار | الوظيفة |
|---|---|---|
| POST | `/setup-password` | `{ token, password }`: التوكن من رابط التفعيل (ما بعد `#token=`). يعمل مرة واحدة ويدخل المستخدم مباشرة |
| POST | `/login` | `{ email, password }`: المطعم يُحدَّد من الإيميل تلقائياً |
| POST | `/refresh` | يجدد التوكن من كوكي `fm_rt` ويبدّلها |
| POST | `/logout` | يُلغي الجلسة |
| GET | `/me` | المستخدم وصلاحياته والمطعم |
| POST | `/change-password` | يُخرج كل الأجهزة الأخرى |

- **التوكن:** صالح 10 دقائق، ويُرسل في `Authorization: Bearer`. في كل طلب يُقرأ المستخدم من قاعدة مطعمه، فالتعطيل وتغيير كلمة المرور وتغيير الصلاحيات تسري فوراً.
- **الجلسة:** كوكي `fm_rt` من نوع httpOnly وSameSite=Strict، مسارها `/api/auth` فقط، ومدتها 30 يوماً تتجدد مع الاستخدام. عند كل تجديد يتبدّل التوكن. إذا ظهر توكن قديم مرة ثانية (سرقة)، تُلغى الجلسة كلها.
- **القفل:** 15 دقيقة بعد 5 محاولات خاطئة.
- **الإلغاء الجماعي:** إيقاف المطعم أو أرشفته يُلغي كل جلساته، وإعادة تعيين وصول المالك من السوبر أدمن تُخرجه من كل الأجهزة.

## الموظفون (`/api/users`) للمالك فقط

`GET /` · `POST /` (دعوة، وتعيد رابط تفعيل) · `PATCH /:id` (الاسم، الهاتف، الصلاحيات، `status: active|disabled`) · `POST /:id/reset-access` · `DELETE /:id` · `GET /permissions`

- **الدور:** كل موظف `Editor`. لا يمكن إعطاؤه `users.manage`، ولا يمكن تعديل حساب المالك من هنا.
- **الإيميل:** فريد على مستوى المنصة كلها.

## ربط لوحة المطعم بالـ API (مهم)

كوكي الجلسة لا تعمل إذا كانت اللوحة والـ API على موقعين مختلفين (مثل netlify.app وrailway.app)، لأن المتصفحات تحجبها. الحل أن تمرّر Netlify طلبات `/api` إلى Railway، فتصبح الكوكي من نفس موقع اللوحة. في `netlify.toml` للوحة المطعم:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://<backend>.up.railway.app/api/:splat"
  status = 200
  force = true
```

بعد ذلك:
- في Railway اضبط `TRUST_PROXY=2` (Netlify ثم Railway)، حتى يرى السيرفر عنوان IP الحقيقي للمستخدم في حدود المحاولات والسجلات.
- `DASHBOARD_URL` هو رابط لوحة المطعم، ومنه تُبنى روابط التفعيل.

## المنيو (`/api/categories`, `/api/products`)

| الطريقة | المسار | الصلاحية |
|---|---|---|
| GET | `/categories` (مع عدد المنتجات) | `menu.view` |
| POST | `/categories` | `categories.create` |
| PATCH | `/categories/:id` (name, isVisible) | `categories.update` |
| PUT | `/categories/order` `{ ids }` | `categories.reorder` |
| DELETE | `/categories/:id?moveTo=<id>` | `categories.delete` |
| GET | `/products?categoryId=` · `/products/:id` | `menu.view` |
| POST | `/products` | `products.create` |
| PATCH | `/products/:id` | `products.update` |
| POST | `/products/:id/availability` `{ isAvailable }` | `products.toggleAvailability` |
| PUT | `/products/order` `{ categoryId, ids }` | `products.reorder` |
| DELETE | `/products/:id` | `products.delete` |

- **السعر:** كل منتج يحتاج `price` أو حجماً واحداً على الأقل في `variants`. الأسعار من 0 إلى 100000، وبثلاث خانات عشرية كحد أقصى (فلس).
- **حذف صنف فيه منتجات:** يُرفض إلا مع `moveTo`، فتنتقل المنتجات لآخر الصنف الهدف بنفس ترتيبها.
- **الترتيب:** يجب أن يحتوي كل العناصر مرة واحدة بالضبط، وإلا يُرفض بـ `INVALID_ORDER`.
- **الحدود:** `maxCategories` و`maxProducts` من إعدادات المطعم في لوحة السوبر أدمن.
- **سجل الأسعار:** كل تغيير سعر يُسجَّل بالقيمة القديمة والجديدة (`product.price_changed`).
- **العزل:** أرقام أصناف ومنتجات مطعم آخر تعيد 404 دائماً.

## الصور

| الطريقة | المسار | الصلاحية |
|---|---|---|
| PUT / DELETE | `/api/products/:id/image` | `images.upload` + `products.update` |
| PUT / DELETE | `/api/categories/:id/image` | `images.upload` + `categories.update` |
| PUT / DELETE | `/api/settings/logo` · `/api/settings/banner` | `images.upload` + `settings.update` |

- **الإرسال:** `multipart/form-data` بحقل واحد اسمه `file`.
- **النوع:** يُحدَّد من أول بايتات الملف (JPG أو PNG أو WebP فقط). الامتداد والنوع المعلن من المتصفح لا يُعتمد عليهما، وSVG مرفوض دائماً.
- **الحجم:** الحد من إعدادات المطعم (`maxImageSizeMB`، افتراضياً 5)، مع سقف عام 20MB.
- **المجلد:** دائماً `restaurants/<restaurantId>/<products|categories|logo|banner>/` ويُحدده الخادم. الصورة القديمة تُحذف عند الاستبدال، وصورة المنتج تُحذف مع حذفه.
- **التخزين:**
  - Cloudinary إذا ضُبطت المفاتيح الثلاثة (بتحويل تلقائي للصيغة والجودة).
  - وإلا في التطوير تُحفظ على القرص في `LOCAL_MEDIA_DIR` وتُخدم من `/media`.
  - وفي الإنتاج بلا Cloudinary يُعطَّل الرفع (503) ويبقى باقي النظام يعمل.

## الإعدادات (`/api/settings`)

`GET` (`settings.view`) · `PATCH` (`settings.update`): `info` (الاسم، الهاتف، واتساب، العنوان، روابط https للتواصل)، و`theme` (لونان بصيغة `#RRGGBB`، والخط من 5 خطوط، و`layout: grid|list`)، و`language: ar|en|both`، و`hideUnavailableProducts`. التحديث جزئي: الحقول غير المرسلة تبقى كما هي.

## المنيو العام (`GET /api/public/menu/:slug`)

بلا تسجيل دخول، ومحدود بـ 240 طلباً في الدقيقة لكل IP.
- **ما يعيده:** الأصناف الظاهرة التي فيها منتجات، والمنتجات (بلا غير المتوفرة إذا طُلب ذلك)، والأسعار، والصور، ومعلومات التواصل العامة. لا يعيد أي معرّف داخلي.
- **الكاش:** كاش في الذاكرة لكل مطعم يُمسح فور أي تعديل. للمتصفح `Cache-Control: no-cache` مع ETag.
- **حالة المطعم:** تُفحص في كل طلب. الموقوف يعيد 403، وغير الموجود 404.
