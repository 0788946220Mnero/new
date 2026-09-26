# دليل النشر — منصة المنيو المجانية

ثلاثة أجزاء:

| الجزء | المستودع | الاستضافة | الرابط المقترح |
|---|---|---|---|
| الباك إند | `free-menu-backend` | Railway | `api.yourdomain.com` أو `xxx.up.railway.app` |
| لوحة السوبر أدمن | `super-admin` | Netlify | `platform.yourdomain.com` |
| المنيو العام + لوحة المطعم | `menu-site` | Netlify (موقع واحد) | `yourdomain.com/<slug>` و`yourdomain.com/admin` |

---

## 1) MongoDB Atlas

1. أنشئ Cluster (يكفي M0 المجاني للبداية، وM10 عند النمو).
2. **Database Access:** أنشئ مستخدماً خاصاً بالتطبيق بدور `readWriteAnyDatabase`. لا تستخدم `atlasAdmin`.
3. **Network Access:** Railway لا يعطي عناوين IP ثابتة في الخطط العادية، فأضف `0.0.0.0/0`. الحماية هنا بكلمة مرور قوية وTLS، وهو الإعداد المعتاد مع Railway.
4. خذ رابط `mongodb+srv://...` بدون اسم قاعدة بعد `/`.

> **حدود M0:** قيود على عدد القواعد والـ collections. كل مطعم يستهلك 5 collections، فخطط للانتقال إلى باقة مدفوعة قبل عشرات المطاعم.

## 2) Cloudinary

1. أنشئ حساباً مجانياً.
2. من Dashboard خذ: Cloud name، وAPI Key، وAPI Secret.
3. ضعها في متغيرات Railway فقط، ولا تضعها أبداً في الواجهات.

## 3) الباك إند على Railway

1. New Project ← Deploy from GitHub ← مستودع `free-menu-backend`.
2. Start command: `npm start` (Node 20 أو أحدث).
3. **Variables:**

```
NODE_ENV=production
TRUST_PROXY=2
MONGODB_URI=mongodb+srv://...
REGISTRY_DB_NAME=restaurant_registry

JWT_ACCESS_SECRET=...        # 3 أسرار مختلفة:
JWT_REFRESH_SECRET=...       # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
PLATFORM_JWT_SECRET=...
MFA_ENCRYPTION_KEY=...       # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

SUPER_ADMIN_EMAIL=ninja@mero.com
SUPER_ADMIN_PASSWORD=...     # مؤقتة، تُحذف بعد الخطوة 5

CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

DASHBOARD_URL=https://yourdomain.com/admin
PUBLIC_MENU_URL=https://yourdomain.com
CORS_ORIGINS=https://platform.yourdomain.com
```

- **`TRUST_PROXY=2`:** لأن الطلبات تمر عبر Netlify ثم Railway، وهكذا يرى السيرفر عنوان IP الحقيقي في حدود المحاولات وسجل التدقيق.
- **`CORS_ORIGINS`:** للوحة السوبر أدمن فقط، لأنها تتصل مباشرة. لوحة المطعم والمنيو العام تمرّان عبر Netlify من نفس الموقع.

4. **Healthcheck:** اجعل مسار الفحص `/health/ready` ليعيد Railway التشغيل إذا انقطعت القاعدة.
5. **أول مرة فقط:** من Railway ← Shell:
   ```
   npm run db:check
   npm run seed:super-admin
   ```
   ثم احذف `SUPER_ADMIN_PASSWORD` من Variables.

## 4) الواجهات على Netlify (موقعان)

### الموقع الرئيسي (`menu-site`): المنيو + لوحة المطاعم على دومين واحد
- Import from Git، وكل الإعدادات من `netlify.toml`.
- في `netlify.toml` غيّر `YOUR-BACKEND.up.railway.app` إلى رابط الباك إند. هذا يمرّر `/api`، فيبقى كوكي الجلسة من نفس الموقع.
- أضف دومينك، ولا تحتاج متغيرات بيئة.

### لوحة السوبر أدمن (`super-admin`): موقع منفصل
- **Environment:** `VITE_API_URL=https://<backend>` و`VITE_PUBLIC_MENU_URL=https://yourdomain.com`.
- **`netlify.toml`:** في `connect-src` ضع رابط الباك إند.
- **الرابط:** اجعله غير متوقع، مثلاً `platform-xxxx.netlify.app`، ولا تضعه تحت دومين المطاعم.

بعد ربط النطاقات حدّث `DASHBOARD_URL` و`PUBLIC_MENU_URL` و`CORS_ORIGINS` (رابط السوبر أدمن) في Railway.

## 5) التحقق بعد النشر

1. `https://<backend>/health/ready` يعيد `ready`.
2. ادخل لوحة السوبر أدمن بـ `ninja@mero.com`، ثم فعّل MFA وغيّر كلمة المرور.
3. أضف مطعماً تجريبياً، ثم افتح رابط المالك من هاتفك واختر كلمة المرور.
4. من `yourdomain.com/admin`: أضف صنفاً ومنتجاً بصورة، ثم افتح «رمز QR» وحمّل ملف PDF، واطبعه وامسحه بهاتف آخر.
5. من السوبر أدمن: أوقف المطعم التجريبي وتأكد أن المنيو يعرض «غير متاح حالياً». ثم احذفه بالأرشفة.

## 6) التشغيل المستمر

- **النسخ الاحتياطي:** فعّل Backups في Atlas (متاح في الباقات المدفوعة). قاعدة كل مطعم منفصلة، فيمكن استعادة مطعم واحد دون الباقي.
- **السجلات:** بصيغة JSON (pino) في Railway. ابحث بـ `restaurantId` أو `requestId`.
- **تدوير الأسرار:**
  - تغيير `JWT_ACCESS_SECRET` يُخرج كل المستخدمين بعد 10 دقائق كحد أقصى.
  - تغيير `JWT_REFRESH_SECRET` يُلغي كل الجلسات فوراً.
  - تغيير `MFA_ENCRYPTION_KEY` يتطلب `npm run seed:super-admin -- --reset-mfa`.
- **فقدان هاتف MFA:** `npm run seed:super-admin -- --reset-mfa`.
- **أكثر من نسخة من الباك إند:** يعمل دون تغيير. كاش المطاعم والمنيو لكل نسخة يتحدث خلال 30 ثانية كحد أقصى، والإيقاف والتعديل فوريان على النسخة التي نفّذتهما.
- **عنقود ثانٍ عند النمو:** أضف `MONGODB_URI__EU2=...` وانقل المطاعم بتغيير `clusterId`، دون أي تعديل في الكود.
