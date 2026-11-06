import type { DocumentSlug } from '../lib/i18n';
import type { SitePage } from './types';

/**
 * The site's pages. Every brand value is a placeholder (`{appName}`,
 * `{supportEmail}`); no brand name is written here. The legal pages are
 * drafts until counsel has reviewed them, and say so on the page.
 */

const privacy: SitePage = {
  draft: true,
  content: {
    en: {
      title: 'Privacy Policy',
      description: 'What {appName} collects, why, who sees it, and the choices you have.',
      sections: [
        {
          heading: 'Who we are',
          body: ['{appName} ("we") runs the {appName} app and this website. Questions about privacy go to {supportEmail}.'],
        },
        {
          heading: 'What we collect',
          body: ['Only what the service needs:'],
          list: [
            'Account data: your phone number, or the Google account you sign in with.',
            'Profile data you choose to share: name, birth date, gender, photos, prompts and profile fields.',
            'Approximate location, to show people near you. Your exact position never leaves our servers: other members see a rounded distance and your city.',
            'Your activity: likes, matches, messages, reports and blocks.',
            'Purchases: the app store tells us what you bought. We never see your card.',
            'Device data: app version, crash reports and a token to send you notifications.',
          ],
        },
        {
          heading: 'Why we use it',
          body: [
            'To run the service (suggestions, matches, chat and calls), to keep it safe (photo and message moderation, verification, fraud and abuse prevention), to process purchases and to answer you. We do not sell personal data.',
          ],
        },
        {
          heading: 'Who sees it',
          body: [
            'Other members see what you put on your profile. Companies that host or process data for us (storage, SMS, moderation, notifications) do so under contract and only on our instructions. We disclose data to authorities only when the law requires it or to protect someone from serious harm.',
          ],
        },
        {
          heading: 'How long we keep it',
          body: [
            'While your account exists. When you delete it, it is hidden from everyone at once, and {graceDays} days later we delete your profile, photos, matches and messages; likes you gave disappear within two more weeks. Purchase records (tax and refund rules) and safety records (reports, moderation decisions and bans, which are kept in a form that does not show your number) are kept for the period the law requires. The exact periods will be listed here before launch.',
          ],
        },
        {
          heading: 'Your choices and rights',
          body: [
            'In the app you can edit your profile, hide your distance or age, pause your account, download your data and delete your account. Without the app, you can delete your account at {deleteAccountPath}. You can also write to {supportEmail} to access, correct or delete your data.',
          ],
        },
        { heading: 'Adults only', body: ['{appName} is only for people aged 18 and over.'] },
      ],
    },
    fa: {
      title: 'سیاست حریم خصوصی',
      description: '{appName} چه اطلاعاتی جمع می‌کند، چرا، چه کسی آن را می‌بیند و چه اختیاری دارید.',
      sections: [
        {
          heading: 'ما چه کسی هستیم',
          body: ['{appName} («ما») اپ {appName} و این وب‌سایت را اداره می‌کند. پرسش‌های مربوط به حریم خصوصی را به {supportEmail} بفرستید.'],
        },
        {
          heading: 'چه اطلاعاتی جمع می‌کنیم',
          body: ['فقط آنچه سرویس به آن نیاز دارد:'],
          list: [
            'اطلاعات حساب: شماره تلفن، یا حساب Google که با آن وارد می‌شوید.',
            'اطلاعات پروفایل که خودتان به اشتراک می‌گذارید: نام، تاریخ تولد، جنسیت، عکس‌ها، پاسخ پرسش‌ها و فیلدهای پروفایل.',
            'موقعیت تقریبی، برای نشان دادن افراد نزدیک. موقعیت دقیق شما هرگز از سرورهای ما بیرون نمی‌رود: دیگران فقط فاصله‌ی گردشده و شهر شما را می‌بینند.',
            'فعالیت شما: لایک‌ها، مچ‌ها، پیام‌ها، گزارش‌ها و مسدودسازی‌ها.',
            'خریدها: فروشگاه اپ به ما می‌گوید چه خریده‌اید. ما هرگز کارت شما را نمی‌بینیم.',
            'اطلاعات دستگاه: نسخه‌ی اپ، گزارش خطا و توکنی برای ارسال اعلان.',
          ],
        },
        {
          heading: 'چرا از آن استفاده می‌کنیم',
          body: [
            'برای اجرای سرویس (پیشنهادها، مچ‌ها، گفتگو و تماس)، حفظ امنیت (نظارت بر عکس و پیام، تأیید هویت، جلوگیری از کلاهبرداری و آزار)، پردازش خریدها و پاسخ به شما. ما اطلاعات شخصی را نمی‌فروشیم.',
          ],
        },
        {
          heading: 'چه کسی آن را می‌بیند',
          body: [
            'دیگر کاربران آنچه را در پروفایل خود گذاشته‌اید می‌بینند. شرکت‌هایی که داده را برای ما نگه‌داری یا پردازش می‌کنند (ذخیره‌سازی، پیامک، نظارت، اعلان) طبق قرارداد و فقط به دستور ما این کار را می‌کنند. اطلاعات را فقط وقتی قانون الزام کند یا برای جلوگیری از آسیب جدی به کسی، در اختیار مراجع قرار می‌دهیم.',
          ],
        },
        {
          heading: 'تا کی نگه‌اش می‌داریم',
          body: [
            'تا وقتی حساب شما وجود دارد. وقتی آن را حذف کنید، بلافاصله از دید همه پنهان می‌شود و {graceDays} روز بعد پروفایل، عکس‌ها، مچ‌ها و پیام‌هایتان را حذف می‌کنیم؛ لایک‌هایی که داده‌اید تا دو هفته‌ی بعد از آن پاک می‌شوند. سوابق خرید (طبق قوانین مالیات و بازپرداخت) و سوابق ایمنی (گزارش‌ها، تصمیم‌های نظارتی و محرومیت‌ها، به شکلی که شماره‌ی شما در آن دیده نمی‌شود) به مدتی که قانون تعیین می‌کند نگه داشته می‌شوند. مدت‌های دقیق پیش از راه‌اندازی این‌جا اعلام می‌شود.',
          ],
        },
        {
          heading: 'اختیارات و حقوق شما',
          body: [
            'در اپ می‌توانید پروفایل خود را ویرایش کنید، فاصله یا سن خود را پنهان کنید، حساب را موقتاً متوقف کنید، داده‌هایتان را دریافت کنید و حساب را حذف کنید. بدون اپ هم می‌توانید حسابتان را در {deleteAccountPath} حذف کنید. برای دسترسی، اصلاح یا حذف داده‌ها می‌توانید به {supportEmail} هم بنویسید.',
          ],
        },
        { heading: 'فقط بزرگسالان', body: ['{appName} فقط برای افراد ۱۸ سال به بالاست.'] },
      ],
    },
    tr: {
      title: 'Gizlilik Politikası',
      description: '{appName} neleri, neden topluyor, kimler görüyor ve hangi seçeneklerin var.',
      sections: [
        {
          heading: 'Biz kimiz',
          body: ['{appName} ("biz"), {appName} uygulamasını ve bu web sitesini işletir. Gizlilikle ilgili soruların için: {supportEmail}.'],
        },
        {
          heading: 'Neleri topluyoruz',
          body: ['Yalnızca hizmetin ihtiyaç duyduklarını:'],
          list: [
            'Hesap bilgileri: telefon numaran ya da giriş yaptığın Google hesabı.',
            'Paylaşmayı seçtiğin profil bilgileri: ad, doğum tarihi, cinsiyet, fotoğraflar, sorulara yanıtlar ve profil alanları.',
            'Yakınındaki insanları göstermek için yaklaşık konum. Tam konumun sunucularımızdan asla çıkmaz: diğer üyeler yuvarlanmış bir mesafe ve şehrini görür.',
            'Etkinliğin: beğeniler, eşleşmeler, mesajlar, şikâyetler ve engellemeler.',
            'Satın almalar: uygulama mağazası neyi satın aldığını bize bildirir. Kartını asla görmeyiz.',
            'Cihaz bilgileri: uygulama sürümü, hata raporları ve bildirim göndermek için bir anahtar.',
          ],
        },
        {
          heading: 'Neden kullanıyoruz',
          body: [
            'Hizmeti çalıştırmak (öneriler, eşleşmeler, sohbet ve aramalar), güvenli tutmak (fotoğraf ve mesaj denetimi, doğrulama, dolandırıcılık ve tacizin önlenmesi), satın almaları işlemek ve sana yanıt vermek için. Kişisel verileri satmayız.',
          ],
        },
        {
          heading: 'Kimler görüyor',
          body: [
            'Diğer üyeler profiline koyduklarını görür. Verileri bizim için barındıran veya işleyen şirketler (depolama, SMS, denetim, bildirimler) bunu sözleşmeyle ve yalnızca bizim talimatımızla yapar. Verileri resmî makamlarla yalnızca yasa gerektirdiğinde ya da birini ciddi bir zarardan korumak için paylaşırız.',
          ],
        },
        {
          heading: 'Ne kadar süre saklıyoruz',
          body: [
            'Hesabın var olduğu sürece. Hesabını sildiğinde hesabın hemen herkesten gizlenir; {graceDays} gün sonra profilini, fotoğraflarını, eşleşmelerini ve mesajlarını sileriz, verdiğin beğeniler de bundan sonraki iki hafta içinde kaybolur. Satın alma kayıtları (vergi ve iade kuralları) ve güvenlik kayıtları (şikâyetler, denetim kararları ve numaranı göstermeyen bir biçimde saklanan yasaklar) yasanın öngördüğü süre boyunca saklanır. Kesin süreler yayından önce burada listelenecek.',
          ],
        },
        {
          heading: 'Seçeneklerin ve hakların',
          body: [
            'Uygulamada profilini düzenleyebilir, mesafeni veya yaşını gizleyebilir, hesabını duraklatabilir, verilerini indirebilir ve hesabını silebilirsin. Uygulama olmadan da hesabını {deleteAccountPath} adresinde silebilirsin. Verilerine erişmek, düzeltmek veya silmek için {supportEmail} adresine de yazabilirsin.',
          ],
        },
        { heading: 'Yalnızca yetişkinler', body: ['{appName} yalnızca 18 yaş ve üzerindeki kişiler içindir.'] },
      ],
    },
  },
};

const terms: SitePage = {
  draft: true,
  content: {
    en: {
      title: 'Terms of Use',
      description: 'The rules for using {appName}.',
      sections: [
        { heading: 'Agreement', body: ['By creating an account you accept these terms and the Community Guidelines.'] },
        {
          heading: 'Who may use {appName}',
          body: ['You must be 18 or older, able to make a binding agreement, and not barred from the service.'],
        },
        {
          heading: 'Your account',
          body: ['One person, one account. Give true information about yourself and keep your sign-in safe.'],
        },
        {
          heading: 'What you post',
          body: [
            'You keep the rights to what you post and allow {appName} to show it within the service. Content that breaks the Community Guidelines may be removed.',
          ],
        },
        {
          heading: 'Subscriptions and purchases',
          body: [
            'Paid features are sold only through the app store you installed {appName} from. Subscriptions renew automatically until you cancel them in that store’s settings, and refunds follow the store’s rules.',
          ],
        },
        {
          heading: 'Suspension and closing an account',
          body: [
            'We may suspend or close an account that breaks these terms. We always tell you the reason, and you can appeal in the app. You can delete your account at any time.',
          ],
        },
        {
          heading: 'Safety',
          body: [
            'We work to keep {appName} safe, but we cannot vouch for every member. Meet in public places, tell a friend where you are going, and report anything that worries you.',
          ],
        },
        { heading: 'Contact', body: ['Questions about these terms: {supportEmail}.'] },
      ],
    },
    fa: {
      title: 'شرایط استفاده',
      description: 'قواعد استفاده از {appName}.',
      sections: [
        { heading: 'توافق', body: ['با ساختن حساب، این شرایط و قوانین جامعه را می‌پذیرید.'] },
        {
          heading: 'چه کسی می‌تواند از {appName} استفاده کند',
          body: ['باید ۱۸ سال یا بیشتر داشته باشید، بتوانید توافقی الزام‌آور ببندید و از سرویس محروم نشده باشید.'],
        },
        {
          heading: 'حساب شما',
          body: ['هر نفر یک حساب. اطلاعات درست درباره‌ی خودتان بدهید و ورود به حسابتان را امن نگه دارید.'],
        },
        {
          heading: 'آنچه منتشر می‌کنید',
          body: [
            'حقوق آنچه منتشر می‌کنید با خودتان می‌ماند و به {appName} اجازه می‌دهید آن را درون سرویس نمایش دهد. محتوایی که قوانین جامعه را نقض کند ممکن است حذف شود.',
          ],
        },
        {
          heading: 'اشتراک‌ها و خریدها',
          body: [
            'امکانات پولی فقط از طریق فروشگاهی فروخته می‌شوند که {appName} را از آن نصب کرده‌اید. اشتراک‌ها تا وقتی در تنظیمات همان فروشگاه لغوشان نکنید خودکار تمدید می‌شوند و بازپرداخت طبق قوانین فروشگاه است.',
          ],
        },
        {
          heading: 'تعلیق و بستن حساب',
          body: [
            'ممکن است حسابی را که این شرایط را نقض کند تعلیق کنیم یا ببندیم. همیشه دلیلش را به شما می‌گوییم و می‌توانید در اپ اعتراض کنید. هر زمان بخواهید می‌توانید حساب خود را حذف کنید.',
          ],
        },
        {
          heading: 'ایمنی',
          body: [
            'برای امن نگه داشتن {appName} تلاش می‌کنیم، اما نمی‌توانیم رفتار هر کاربر را تضمین کنیم. در مکان‌های عمومی قرار بگذارید، به یک دوست بگویید کجا می‌روید و هر چیزی را که نگرانتان می‌کند گزارش دهید.',
          ],
        },
        { heading: 'تماس', body: ['پرسش‌ها درباره‌ی این شرایط: {supportEmail}.'] },
      ],
    },
    tr: {
      title: 'Kullanım Koşulları',
      description: '{appName} kullanım kuralları.',
      sections: [
        { heading: 'Sözleşme', body: ['Hesap oluşturarak bu koşulları ve Topluluk Kuralları’nı kabul etmiş olursun.'] },
        {
          heading: '{appName} kimler kullanabilir',
          body: ['18 yaşında veya daha büyük olmalı, bağlayıcı bir sözleşme yapabilmeli ve hizmetten men edilmemiş olmalısın.'],
        },
        {
          heading: 'Hesabın',
          body: ['Bir kişi, bir hesap. Kendin hakkında doğru bilgi ver ve girişini güvende tut.'],
        },
        {
          heading: 'Paylaştıkların',
          body: [
            'Paylaştıklarının hakları sende kalır; {appName} uygulamasının bunları hizmet içinde göstermesine izin verirsin. Topluluk Kuralları’nı ihlal eden içerik kaldırılabilir.',
          ],
        },
        {
          heading: 'Abonelikler ve satın almalar',
          body: [
            'Ücretli özellikler yalnızca {appName} uygulamasını yüklediğin mağaza üzerinden satılır. Abonelikler, o mağazanın ayarlarından iptal edene kadar otomatik olarak yenilenir; iadeler mağazanın kurallarına tabidir.',
          ],
        },
        {
          heading: 'Askıya alma ve hesabın kapatılması',
          body: [
            'Bu koşulları ihlal eden bir hesabı askıya alabilir veya kapatabiliriz. Nedenini her zaman bildiririz ve uygulamada itiraz edebilirsin. Hesabını istediğin zaman silebilirsin.',
          ],
        },
        {
          heading: 'Güvenlik',
          body: [
            '{appName} uygulamasını güvenli tutmak için çalışıyoruz, ancak her üyeye kefil olamayız. Halka açık yerlerde buluş, nereye gittiğini bir arkadaşına söyle ve seni endişelendiren her şeyi bildir.',
          ],
        },
        { heading: 'İletişim', body: ['Bu koşullarla ilgili sorular: {supportEmail}.'] },
      ],
    },
  },
};

const communityGuidelines: SitePage = {
  draft: true,
  content: {
    en: {
      title: 'Community Guidelines',
      description: 'The rules that keep {appName} safe and respectful.',
      sections: [
        {
          heading: 'Be yourself',
          body: ['Use your own recent photos and true information. No fake profiles and no pretending to be someone else.'],
        },
        { heading: 'Adults only', body: ['Members must be 18 or older. Anything that sexualizes minors is banned outright.'] },
        {
          heading: 'Respect others',
          body: ['No harassment, hate speech, threats or bullying, and no unwanted sexual messages. A “no” ends the conversation.'],
        },
        { heading: 'Keep it clean', body: ['No nudity or sexual content in photos, prompts or messages.'] },
        {
          heading: 'No scams, no selling',
          body: ['Never ask members for money, investments or cryptocurrency, and do not advertise or recruit for other services.'],
        },
        { heading: 'Nothing illegal or violent', body: ['No violence, weapons, drugs or anything else illegal.'] },
        {
          heading: 'Report and block',
          body: [
            'Every profile and conversation has Report and Block. Our team reviews every report, and we tell you when we have acted.',
          ],
        },
        {
          heading: 'What happens when rules are broken',
          body: [
            'Depending on how serious it is: content removal, a warning, a suspension or a permanent ban. Every action comes with its reason, and you can appeal in the app.',
          ],
        },
      ],
    },
    fa: {
      title: 'قوانین جامعه',
      description: 'قواعدی که {appName} را امن و محترمانه نگه می‌دارد.',
      sections: [
        {
          heading: 'خودتان باشید',
          body: ['عکس‌های تازه‌ی خودتان و اطلاعات درست بگذارید. پروفایل جعلی و جا زدن خود به جای دیگری ممنوع است.'],
        },
        { heading: 'فقط بزرگسالان', body: ['کاربران باید ۱۸ سال یا بیشتر داشته باشند. هر چیزی که کودکان را جنسی جلوه دهد مطلقاً ممنوع است.'] },
        {
          heading: 'به دیگران احترام بگذارید',
          body: ['آزار، نفرت‌پراکنی، تهدید و قلدری ممنوع است و پیام جنسیِ ناخواسته هم. «نه» یعنی پایان گفتگو.'],
        },
        { heading: 'پاکیزه بمانید', body: ['برهنگی و محتوای جنسی در عکس‌ها، پاسخ‌ها و پیام‌ها ممنوع است.'] },
        {
          heading: 'نه کلاهبرداری، نه فروش',
          body: ['هرگز از کاربران پول، سرمایه‌گذاری یا رمزارز نخواهید و برای سرویس‌های دیگر تبلیغ یا عضوگیری نکنید.'],
        },
        { heading: 'هیچ کار غیرقانونی یا خشونت‌آمیز', body: ['خشونت، سلاح، مواد مخدر و هر چیز غیرقانونی دیگر ممنوع است.'] },
        {
          heading: 'گزارش و مسدودسازی',
          body: ['هر پروفایل و هر گفتگو گزینه‌ی گزارش و مسدودسازی دارد. تیم ما همه‌ی گزارش‌ها را بررسی می‌کند و وقتی اقدام کردیم به شما خبر می‌دهیم.'],
        },
        {
          heading: 'وقتی قانونی نقض شود',
          body: [
            'بسته به شدت آن: حذف محتوا، هشدار، تعلیق یا محرومیت دائمی. هر اقدام همراه با دلیلش است و می‌توانید در اپ اعتراض کنید.',
          ],
        },
      ],
    },
    tr: {
      title: 'Topluluk Kuralları',
      description: '{appName} uygulamasını güvenli ve saygılı tutan kurallar.',
      sections: [
        {
          heading: 'Kendin ol',
          body: ['Kendi güncel fotoğraflarını ve doğru bilgileri kullan. Sahte profil yok, başkası gibi davranmak yok.'],
        },
        { heading: 'Yalnızca yetişkinler', body: ['Üyeler 18 yaşında veya daha büyük olmalıdır. Küçükleri cinselleştiren her şey kesinlikle yasaktır.'] },
        {
          heading: 'Başkalarına saygı göster',
          body: ['Taciz, nefret söylemi, tehdit ve zorbalık yok; istenmeyen cinsel mesajlar da yok. “Hayır” sohbeti bitirir.'],
        },
        { heading: 'Temiz tut', body: ['Fotoğraflarda, yanıtlarda ve mesajlarda çıplaklık veya cinsel içerik yok.'] },
        {
          heading: 'Dolandırıcılık yok, satış yok',
          body: ['Üyelerden asla para, yatırım veya kripto para isteme; başka hizmetlerin reklamını yapma ya da onlara üye toplama.'],
        },
        { heading: 'Yasa dışı veya şiddet içeren hiçbir şey', body: ['Şiddet, silah, uyuşturucu ve yasa dışı her şey yasaktır.'] },
        {
          heading: 'Bildir ve engelle',
          body: ['Her profilde ve her sohbette Bildir ve Engelle vardır. Ekibimiz her bildirimi inceler ve işlem yaptığımızda sana haber veririz.'],
        },
        {
          heading: 'Kurallar ihlal edildiğinde',
          body: [
            'Ciddiyetine göre: içeriğin kaldırılması, uyarı, askıya alma veya kalıcı yasak. Her işlemin nedeni bildirilir ve uygulamada itiraz edebilirsin.',
          ],
        },
      ],
    },
  },
};

const childSafety: SitePage = {
  draft: true,
  content: {
    en: {
      title: '{appName} Child Safety Standards',
      description: '{appName} has zero tolerance for child sexual abuse and exploitation (CSAE). This page sets out the standards {appName} follows.',
      sections: [
        {
          heading: 'Adults only',
          body: [
            '{appName} is for people aged 18 and over. We ask for a birth date at sign-up and remove any account we believe belongs to a minor.',
          ],
        },
        {
          heading: 'What is prohibited',
          body: [
            'Any content or behaviour that sexualizes, exploits or endangers children, including child sexual abuse material (CSAM), grooming and sextortion. It leads to an immediate, permanent ban.',
          ],
        },
        {
          heading: 'Prevention',
          body: [
            'Photos are checked before other members can see them, and profile texts and messages are screened for known abuse. Accounts that appear to belong to a minor are removed.',
          ],
        },
        {
          heading: 'Reporting inside the app',
          body: ['Anyone can report a profile or a message from inside {appName}:'],
          list: [
            'Open the profile or the conversation.',
            'Choose Report.',
            'Pick the reason about a minor or child safety, and add what you saw.',
          ],
          ordered: true,
        },
        {
          heading: 'How we handle reports',
          body: [
            'Reports about child safety are reviewed before all others. We remove the content, ban the account and keep the evidence the law requires.',
          ],
        },
        {
          heading: 'Working with the authorities',
          body: [
            'We report child sexual abuse material and child exploitation to the competent authorities, such as the National Center for Missing & Exploited Children (NCMEC) or the national authority where the law requires it, and we comply with the child safety laws that apply to {appName}.',
          ],
        },
        {
          heading: 'Child safety contact',
          body: [
            'Our child safety contact can be reached at {supportEmail}. If a child is in immediate danger, call your local emergency number first.',
          ],
        },
      ],
    },
    fa: {
      title: 'استانداردهای ایمنی کودکان {appName}',
      description: '{appName} در برابر سوءاستفاده و بهره‌کشی جنسی از کودکان (CSAE) هیچ تحملی ندارد. این صفحه استانداردهایی را که {appName} رعایت می‌کند شرح می‌دهد.',
      sections: [
        {
          heading: 'فقط بزرگسالان',
          body: ['{appName} برای افراد ۱۸ سال به بالاست. هنگام ثبت‌نام تاریخ تولد را می‌پرسیم و هر حسابی را که فکر کنیم متعلق به فردی زیر سن قانونی است حذف می‌کنیم.'],
        },
        {
          heading: 'چه چیزی ممنوع است',
          body: [
            'هر محتوا یا رفتاری که کودکان را جنسی جلوه دهد، از آن‌ها بهره‌کشی کند یا آن‌ها را به خطر بیندازد، از جمله محتوای سوءاستفاده‌ی جنسی از کودکان (CSAM)، فریب‌دادن کودکان (grooming) و اخاذی جنسی. نتیجه‌ی آن محرومیت فوری و دائمی است.',
          ],
        },
        {
          heading: 'پیشگیری',
          body: [
            'عکس‌ها پیش از آن‌که دیگر کاربران ببینندشان بررسی می‌شوند و متن پروفایل‌ها و پیام‌ها از نظر نمونه‌های شناخته‌شده‌ی سوءاستفاده بررسی می‌شود. حساب‌هایی که به نظر برسد متعلق به افراد زیر سن قانونی‌اند حذف می‌شوند.',
          ],
        },
        {
          heading: 'گزارش از داخل اپ',
          body: ['هر کسی می‌تواند از داخل {appName} یک پروفایل یا پیام را گزارش کند:'],
          list: ['پروفایل یا گفتگو را باز کنید.', 'گزینه‌ی گزارش را بزنید.', 'دلیل مربوط به کودک یا ایمنی کودکان را انتخاب کنید و آنچه دیده‌اید را بنویسید.'],
          ordered: true,
        },
        {
          heading: 'رسیدگی به گزارش‌ها',
          body: [
            'گزارش‌های مربوط به ایمنی کودکان پیش از همه‌ی گزارش‌های دیگر بررسی می‌شوند. محتوا را حذف می‌کنیم، حساب را محروم می‌کنیم و شواهد را طبق الزام قانون نگه می‌داریم.',
          ],
        },
        {
          heading: 'همکاری با مراجع قانونی',
          body: [
            'محتوای سوءاستفاده‌ی جنسی از کودکان و بهره‌کشی از کودکان را به مراجع صلاحیت‌دار، مانند National Center for Missing & Exploited Children (NCMEC) یا مرجع ملی هر جا که قانون الزام کند، گزارش می‌دهیم و از قوانین ایمنی کودکان که بر {appName} حاکم است پیروی می‌کنیم.',
          ],
        },
        {
          heading: 'تماس درباره‌ی ایمنی کودکان',
          body: ['مسئول ایمنی کودکان ما از راه {supportEmail} در دسترس است. اگر کودکی در خطر فوری است، اول با شماره‌ی اضطراری محلی تماس بگیرید.'],
        },
      ],
    },
    tr: {
      title: '{appName} Çocuk Güvenliği Standartları',
      description: '{appName}, çocukların cinsel istismarına ve sömürüsüne (CSAE) karşı sıfır tolerans uygular. Bu sayfa {appName} uygulamasının uyduğu standartları anlatır.',
      sections: [
        {
          heading: 'Yalnızca yetişkinler',
          body: ['{appName} 18 yaş ve üzerindeki kişiler içindir. Kayıt sırasında doğum tarihi isteriz ve reşit olmayan birine ait olduğunu düşündüğümüz her hesabı kaldırırız.'],
        },
        {
          heading: 'Neler yasaktır',
          body: [
            'Çocuk cinsel istismarı materyali (CSAM), çocukları kandırarak yaklaşma (grooming) ve cinsel şantaj dahil, çocukları cinselleştiren, sömüren veya tehlikeye atan her türlü içerik ve davranış. Sonucu anında ve kalıcı yasaktır.',
          ],
        },
        {
          heading: 'Önleme',
          body: [
            'Fotoğraflar diğer üyeler görmeden önce kontrol edilir; profil metinleri ve mesajlar bilinen istismar örneklerine karşı taranır. Reşit olmayan birine ait görünen hesaplar kaldırılır.',
          ],
        },
        {
          heading: 'Uygulama içinden bildirme',
          body: ['Herkes {appName} içinden bir profili veya mesajı bildirebilir:'],
          list: ['Profili veya sohbeti aç.', 'Bildir’i seç.', 'Reşit olmayan biri veya çocuk güvenliğiyle ilgili nedeni seç ve gördüğünü ekle.'],
          ordered: true,
        },
        {
          heading: 'Bildirimleri nasıl ele alıyoruz',
          body: [
            'Çocuk güvenliğiyle ilgili bildirimler herkesten önce incelenir. İçeriği kaldırır, hesabı yasaklar ve yasanın gerektirdiği delilleri saklarız.',
          ],
        },
        {
          heading: 'Resmî makamlarla iş birliği',
          body: [
            'Çocuk cinsel istismarı materyalini ve çocuk sömürüsünü, National Center for Missing & Exploited Children (NCMEC) gibi yetkili makamlara veya yasanın gerektirdiği yerde ulusal makama bildiririz ve {appName} için geçerli çocuk güvenliği yasalarına uyarız.',
          ],
        },
        {
          heading: 'Çocuk güvenliği iletişimi',
          body: ['Çocuk güvenliği sorumlumuza {supportEmail} adresinden ulaşabilirsin. Bir çocuk acil tehlikedeyse önce yerel acil durum numarasını ara.'],
        },
      ],
    },
  },
};

const support: SitePage = {
  draft: false,
  content: {
    en: {
      title: 'Support',
      description: 'How to reach the {appName} team, report someone, appeal a decision and get answers to common questions.',
      sections: [
        { heading: 'Write to us', body: ['E-mail {supportEmail}. You can write in Persian, English or Turkish. In the app, Settings also has a Support section where you can write to us and see our answers.'] },
        {
          heading: 'Report someone',
          body: [
            'Open the person’s profile or your conversation with them and choose Report. Pick a reason and add what happened; you can block them at the same time. Reports go straight to our moderation team, and we tell you when we have acted. If someone is in danger, call your local emergency number first.',
          ],
        },
        {
          heading: 'If we restricted your account',
          body: [
            'When we warn, suspend or ban an account, the app always shows the reason. If you think we got it wrong, appeal from the app:',
          ],
          list: [
            'Open {appName}. The notice about your account opens by itself.',
            'Choose Appeal and tell us what we should know.',
            'A person on our team reviews it. The answer appears in the app, and a lifted restriction takes effect at once.',
          ],
          ordered: true,
        },
        {
          heading: 'Common questions',
          body: [],
          faq: [
            {
              question: 'I did not get the sign-in code.',
              answer:
                'Check that the number, with its country code, is right. Text messages can take a minute; you can ask for a new code after 60 seconds. If it still does not arrive, write to {supportEmail} with the number’s country.',
            },
            {
              question: 'How do I cancel a subscription?',
              answer:
                'In the store you bought it from: Google Play (Payments and subscriptions) or the Cafe Bazaar app. Uninstalling the app or deleting your account does not cancel it.',
            },
            {
              question: 'A purchase does not show up in the app.',
              answer:
                'Open the subscription screen in the app and choose Restore purchases. If it is still missing, write to us with the store’s receipt.',
            },
            {
              question: 'Can I pause my account instead of deleting it?',
              answer: 'Yes. Pausing hides your profile from new people; your matches and conversations stay. Turn it off whenever you like.',
            },
            {
              question: 'How do I delete my account?',
              answer: 'In the app, or without it at {deleteAccountPath}.',
            },
          ],
        },
        {
          heading: 'Purchases and refunds',
          body: [
            'Purchases are made through your app store, and refunds follow its rules. Paid features are tied to the store you bought them in.',
          ],
        },
      ],
    },
    fa: {
      title: 'پشتیبانی',
      description: 'راه‌های تماس با تیم {appName}، گزارش یک کاربر، اعتراض به یک تصمیم و پاسخ پرسش‌های رایج.',
      sections: [
        { heading: 'به ما بنویسید', body: ['به {supportEmail} ایمیل بزنید. می‌توانید به فارسی، انگلیسی یا ترکی بنویسید. در اپ هم بخش پشتیبانی در تنظیمات هست که می‌توانید از آن‌جا به ما بنویسید و پاسخ‌ها را ببینید.'] },
        {
          heading: 'گزارش یک کاربر',
          body: [
            'پروفایل آن فرد یا گفتگو با او را باز کنید و گزینه‌ی گزارش را بزنید. دلیلی انتخاب کنید و آنچه پیش آمده را بنویسید؛ هم‌زمان می‌توانید او را مسدود هم کنید. گزارش مستقیم به تیم نظارت ما می‌رسد و وقتی اقدام کردیم به شما خبر می‌دهیم. اگر کسی در خطر است، اول با شماره‌ی اضطراری محلی تماس بگیرید.',
          ],
        },
        {
          heading: 'اگر حساب شما محدود شده است',
          body: ['وقتی به حسابی هشدار می‌دهیم، آن را تعلیق یا محروم می‌کنیم، اپ همیشه دلیلش را نشان می‌دهد. اگر فکر می‌کنید اشتباه کرده‌ایم، از داخل اپ اعتراض کنید:'],
          list: [
            '{appName} را باز کنید. پیام مربوط به حسابتان خودش باز می‌شود.',
            'گزینه‌ی اعتراض را بزنید و آنچه باید بدانیم را بنویسید.',
            'یکی از اعضای تیم ما آن را بررسی می‌کند. پاسخ در اپ نشان داده می‌شود و اگر محدودیت برداشته شود، همان لحظه اعمال می‌شود.',
          ],
          ordered: true,
        },
        {
          heading: 'پرسش‌های رایج',
          body: [],
          faq: [
            {
              question: 'کد ورود به دستم نرسید.',
              answer:
                'مطمئن شوید شماره، همراه با کد کشور، درست است. پیامک ممکن است یک دقیقه طول بکشد؛ پس از ۶۰ ثانیه می‌توانید کد تازه بخواهید. اگر باز هم نرسید، با ذکر کشور آن شماره به {supportEmail} بنویسید.',
            },
            {
              question: 'اشتراک را چطور لغو کنم؟',
              answer: 'در فروشگاهی که از آن خریده‌اید: گوگل پلی (بخش پرداخت‌ها و اشتراک‌ها) یا اپ کافه‌بازار. حذف اپ از گوشی یا حذف حساب، اشتراک را لغو نمی‌کند.',
            },
            {
              question: 'خریدم در اپ دیده نمی‌شود.',
              answer: 'صفحه‌ی اشتراک را در اپ باز کنید و «بازیابی خرید» را بزنید. اگر باز هم نبود، با رسید فروشگاه به ما بنویسید.',
            },
            {
              question: 'می‌توانم به‌جای حذف، حسابم را موقتاً متوقف کنم؟',
              answer: 'بله. با توقف موقت، پروفایل شما به افراد تازه نشان داده نمی‌شود و مچ‌ها و گفتگوهایتان می‌مانند. هر وقت خواستید آن را خاموش کنید.',
            },
            {
              question: 'حسابم را چطور حذف کنم؟',
              answer: 'در اپ، یا بدون اپ در {deleteAccountPath}.',
            },
          ],
        },
        {
          heading: 'خرید و بازپرداخت',
          body: ['خریدها از طریق فروشگاه اپ شما انجام می‌شوند و بازپرداخت طبق قوانین آن است. امکانات پولی به فروشگاهی که از آن خریده‌اید وابسته‌اند.'],
        },
      ],
    },
    tr: {
      title: 'Destek',
      description: '{appName} ekibine nasıl ulaşılır, biri nasıl bildirilir, bir karara nasıl itiraz edilir ve sık sorulan sorular.',
      sections: [
        { heading: 'Bize yaz', body: ['{supportEmail} adresine e-posta gönder. Farsça, İngilizce veya Türkçe yazabilirsin. Uygulamada Ayarlar’daki Destek bölümünden de bize yazabilir ve yanıtlarımızı görebilirsin.'] },
        {
          heading: 'Birini bildir',
          body: [
            'Kişinin profilini veya onunla sohbetini aç ve Bildir’i seç. Bir neden seç ve ne olduğunu ekle; aynı anda engelleyebilirsin de. Bildirimler doğrudan denetim ekibimize ulaşır ve işlem yaptığımızda sana haber veririz. Biri tehlikedeyse önce yerel acil durum numarasını ara.',
          ],
        },
        {
          heading: 'Hesabın kısıtlandıysa',
          body: ['Bir hesabı uyardığımızda, askıya aldığımızda veya yasakladığımızda uygulama nedenini her zaman gösterir. Yanıldığımızı düşünüyorsan uygulamadan itiraz et:'],
          list: [
            '{appName} uygulamasını aç. Hesabınla ilgili bildirim kendiliğinden açılır.',
            'İtiraz et’i seç ve bilmemiz gerekenleri yaz.',
            'Ekibimizden biri inceler. Yanıt uygulamada görünür; kaldırılan bir kısıtlama hemen geçerli olur.',
          ],
          ordered: true,
        },
        {
          heading: 'Sık sorulan sorular',
          body: [],
          faq: [
            {
              question: 'Giriş kodu gelmedi.',
              answer:
                'Numaranın ülke koduyla birlikte doğru olduğundan emin ol. SMS bir dakika kadar sürebilir; 60 saniye sonra yeni kod isteyebilirsin. Yine gelmezse numaranın ülkesini belirterek {supportEmail} adresine yaz.',
            },
            {
              question: 'Aboneliğimi nasıl iptal ederim?',
              answer: 'Satın aldığın mağazadan: Google Play (Ödemeler ve abonelikler) veya Cafe Bazaar uygulaması. Uygulamayı kaldırmak veya hesabını silmek aboneliği iptal etmez.',
            },
            {
              question: 'Bir satın alma uygulamada görünmüyor.',
              answer: 'Uygulamada abonelik ekranını aç ve Satın alımları geri yükle’yi seç. Hâlâ görünmüyorsa mağaza makbuzuyla bize yaz.',
            },
            {
              question: 'Hesabımı silmek yerine duraklatabilir miyim?',
              answer: 'Evet. Duraklatınca profilin yeni kişilere gösterilmez; eşleşmelerin ve sohbetlerin kalır. İstediğin zaman kapatabilirsin.',
            },
            {
              question: 'Hesabımı nasıl silerim?',
              answer: 'Uygulamada ya da uygulama olmadan {deleteAccountPath} adresinde.',
            },
          ],
        },
        {
          heading: 'Satın almalar ve iadeler',
          body: ['Satın almalar uygulama mağazan üzerinden yapılır ve iadeler onun kurallarına tabidir. Ücretli özellikler satın aldığın mağazaya bağlıdır.'],
        },
      ],
    },
  },
};

export const sitePages: Readonly<Record<DocumentSlug, SitePage>> = {
  privacy,
  terms,
  'community-guidelines': communityGuidelines,
  'child-safety': childSafety,
  support,
};
