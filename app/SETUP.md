# המגדלור, פעימה 1: הוראות פריסה והפעלה

> מסמך לראש המטה. המשתמש לא מבצע כאן שום צעד: כל מה שלמטה באחריות המערכת.
> נכתב על ידי המפתח/ת, 7.7.2026.

## 1. SQL שנדרש להריץ ב-Supabase (פעם אחת)

### 1א. טבלת בקשות הצטרפות (מסך "כמעט סיימנו")

```sql
create table if not exists public.migdalor_join_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null default '',
  phone text not null default '',
  handled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.migdalor_join_requests enable row level security;

-- כל משתמש מחובר יכול להשאיר בקשה על המייל של עצמו בלבד
create policy join_requests_insert on public.migdalor_join_requests
  for insert with check (
    email = (select email from public.migdalor_profiles where id = auth.uid())
  );

-- רק אדמין רואה ומטפל
create policy join_requests_admin_select on public.migdalor_join_requests
  for select using (public.migdalor_role() = 'admin');
create policy join_requests_admin_update on public.migdalor_join_requests
  for update using (public.migdalor_role() = 'admin');
```

### 1ב. תיקון באג ב-RLS הקיים (חובה, בלעדיו מסך המנטור לא יראה כותרות)

במדיניות `recordings_select` על `migdalor_recordings` נכתב בטעות
`s.recording_id = s.id` (השוואה של שיתוף לעצמו) במקום השוואה להקלטה.
התוצאה: מנטור לא יכול לקרוא את פרטי ההקלטות ששותפו איתו. התיקון:

```sql
drop policy recordings_select on public.migdalor_recordings;
create policy recordings_select on public.migdalor_recordings
  for select using (
    owner_id = auth.uid()
    or public.migdalor_role() = 'admin'
    or exists (
      select 1 from public.migdalor_shares s
      where s.recording_id = migdalor_recordings.id
        and s.revoked = false
        and s.shared_with_email = public.migdalor_email()
    )
  );
```

## 2. הגדרת Google OAuth ב-Supabase

1. ב-Dashboard: Authentication > Providers > Google: להפעיל, עם Client ID
   ו-Client Secret מפרויקט Google Cloud (OAuth consent screen מסוג External,
   עם היקפי email ו-profile בלבד).
2. ב-Google Cloud Console, ב-Authorized redirect URIs של ה-OAuth Client:
   `https://ndrhiikczkbosentclnh.supabase.co/auth/v1/callback`
3. ב-Supabase: Authentication > URL Configuration:
   - Site URL: `https://nirbosco.github.io/migdalor/app/`
   - Redirect URLs: להוסיף
     `https://nirbosco.github.io/migdalor/app/*`
     (ולתקופת הבדיקות גם `http://localhost:*`)

## 3. פריסת ה-Worker (מחליף את worker הספייק)

1. Workers & Pages > Create Worker בשם `migdalor` (לא לדרוס את
   `migdalor-spike` עד שהמוצר מאומת), להדביק את `app/worker.js`.
2. Settings > Variables and Secrets:
   - `SUPABASE_URL` = `https://ndrhiikczkbosentclnh.supabase.co` (רגיל)
   - `SUPABASE_ANON` = מפתח ה-anon (רגיל)
   - `SUPABASE_SERVICE_KEY` = מפתח ה-service_role מ-Supabase (Secret!
     נמצא ב-Settings > API Keys. לעולם לא בקוד צד לקוח)
3. Settings > Bindings > R2 bucket: שם משתנה `BUCKET`, דלי `migdalor-spike`
   (או דלי חדש `migdalor` אם רוצים הפרדה מהספייק; אין תלות בשם).
4. Deploy, ולקחת את הכתובת (למשל
   `https://migdalor.nirbosco-com-yotzer-education.workers.dev`).

## 4. חיבור האפליקציה

1. ב-`app/js/config.js` להחליף את `WORKER_URL` בכתובת ה-Worker מהצעד הקודם.
2. שם וטלפון של איש הקשר האנושי (מופיעים בכל מבוי סתום):
   `CONTACT_NAME`, `CONTACT_PHONE` באותו קובץ. כרגע placeholder ("הצוות").
3. לפרוס את תיקיית `app/` לריפו `nirbosco/migdalor` תחת `app/`
   (GitHub Pages כבר פעיל שם עבור הספייק). הכתובת:
   `https://nirbosco.github.io/migdalor/app/`
4. לזרוע אדמין ראשון ב-roster (בלי זה אין מי שישבץ):

```sql
insert into public.migdalor_roster (email, full_name, role)
values ('nirbosco@gmail.com', 'ניר', 'admin')
on conflict (email) do update set role = 'admin';
```

## 5. מה נבדק ומה ממתין

### נבדק על ידי המפתח/ת (7.7.2026, מקומית)

- `node --check` על כל קובצי ה-JS: תחביר תקין.
- שרת סטטי מקומי + דפדפן preview, במצב תצוגה (`?dev=1`):
  - מסך כניסה, מסך "כמעט סיימנו", מסך ברוכים הבאים (פעם ראשונה).
  - הבית: כרטיסים עם סטטוסים ("נשלח לאהוד, נצפה" / "עדיין לא שותף"),
    מצב ריק, מצב שגיאה, פס אופליין.
  - שלושת מסכי ההכנה, כולל בחירת מצלמה ומיקרופון ומד קול
    (מצלמה מדומה: canvas + oscillator עם סטאב של getUserMedia).
  - הקלטה מלאה עם שעון, מד קול, אישור כפול לסיום, והרכבת קובץ webm
    מהמקטעים ששמורים ב-IndexedDB, כולל תיקון המשך (webm-fix).
  - מסך אחרי העצירה: שם ברירת מחדל, בחירת מנטורים (עד 3), הודעות ההעלאה.
  - מסך צפייה, מסך מנטור, פאנל אדמין (נתוני הדגמה), כולל פענוח CSV.
- זרימת ההקלטה מקצה לקצה עם מצלמה מדומה: הקלטה, עצירה, הרכבה, תיקון משך.

### ממתין לבדיקת אינטגרציה (אחרי הפריסה, באחריות ראש המטה)

- התחברות גוגל אמיתית (דורשת את סעיף 2), כולל משתמש שאינו ב-roster.
- העלאת multipart אמיתית דרך ה-Worker החדש והמשכת העלאה אחרי ניתוק.
- צפייה מאומתת: נמען מורשה (200), משתמש זר (403), רישום צפייה פעם ביום.
- מסך המנטור מול נתונים אמיתיים (אחרי תיקון ה-RLS בסעיף 1ב).
- פיילוט 5 עד 10 חותמים לפי תנאי פרקליט השטן, לפני פריסה רחבה.

## 6. הערות לעתיד (לא בפעימה 1)

- **מייל למנטור:** אין שרת מייל בפעימה 1; השליחה היא וואטסאפ + העתקת קישור.
  כשיוחלט להוסיף מייל, הדרך הזולה: Supabase Edge Function + Resend
  (3,000 מיילים בחודש בחינם), נשלח מה-Worker בעת יצירת share.
- **מצב תצוגה (`?dev=1`):** נשאר בכוונה. הוא מציג נתוני הדגמה בלבד ולא
  עוקף שום הרשאה (ה-RLS בשרת חוסם ממילא). שימושי להדרכה ולבדיקות עתידיות.
- **אבטחה, ידוע ומתועד:** טוקן הצפייה עובר ב-URL של הווידאו יחד עם JWT קצר
  מועד (`&auth=`), כי תג וידאו לא שולח כותרות. ה-JWT פג תוך שעה, הקישור
  עצמו חסר ערך בלי התחברות, וה-Worker בודק הכול בשרת.
- **advisory של Supabase שלא קשור למגדלור:** בטבלת `public.events`
  (של פרויקט "מקומי"/חותמנמי) ה-RLS כבוי והטבלה חשופה לכתיבה עם מפתח anon.
  לא נגעתי (מחוץ לתחום שלי), אבל צריך להחזיר את זה לצוות של אותו פרויקט:
  `ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;` + פוליסות מתאימות.

## 7. כתובות בדיקה אחרי פריסה

- כניסת חותם: `https://nirbosco.github.io/migdalor/app/`
- מסך מנטור: `https://nirbosco.github.io/migdalor/app/mentor.html`
- פאנל אדמין: `https://nirbosco.github.io/migdalor/app/admin.html`
- צפייה: `https://nirbosco.github.io/migdalor/app/watch.html?token=...`
- סיור ממשק בלי חשבון (נתוני הדגמה): להוסיף `?dev=1` לכל אחת מהכתובות.
