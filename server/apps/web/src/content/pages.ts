import type { PageSlug } from '../lib/i18n';
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
            'Account data: your phone number, or the e-mail address of the Apple or Google account you sign in with.',
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
            'While your account exists. When you delete it, we delete your profile, photos and messages. Records the law makes us keep (purchases) and records of safety actions (such as a ban for abuse) are kept for the period the law requires. The exact periods will be listed here before launch.',
          ],
        },
        {
          heading: 'Your choices and rights',
          body: [
            'In the app you can edit your profile, hide your distance or age, pause your account, download your data and delete your account. You can also write to {supportEmail} to access, correct or delete your data.',
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
            'اطلاعات حساب: شماره تلفن، یا ایمیل حساب Apple یا Google که با آن وارد می‌شوید.',
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
            'تا وقتی حساب شما وجود دارد. وقتی آن را حذف کنید، پروفایل، عکس‌ها و پیام‌هایتان را حذف می‌کنیم. سوابقی که قانون نگه‌داری‌شان را الزامی می‌کند (خریدها) و سوابق اقدامات ایمنی (مثلاً محرومیت به دلیل آزار) به مدتی که قانون تعیین می‌کند نگه داشته می‌شوند. مدت‌های دقیق پیش از راه‌اندازی این‌جا اعلام می‌شود.',
          ],
        },
        {
          heading: 'اختیارات و حقوق شما',
          body: [
            'در اپ می‌توانید پروفایل خود را ویرایش کنید، فاصله یا سن خود را پنهان کنید، حساب را موقتاً متوقف کنید، داده‌هایتان را دریافت کنید و حساب را حذف کنید. برای دسترسی، اصلاح یا حذف داده‌ها می‌توانید به {supportEmail} هم بنویسید.',
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
            'Hesap bilgileri: telefon numaran ya da giriş yaptığın Apple veya Google hesabının e-posta adresi.',
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
            'Hesabın var olduğu sürece. Hesabını sildiğinde profilini, fotoğraflarını ve mesajlarını sileriz. Yasanın saklamamızı zorunlu kıldığı kayıtlar (satın almalar) ve güvenlik işlemlerinin kayıtları (örneğin taciz nedeniyle verilen bir yasak) yasanın öngördüğü süre boyunca saklanır. Kesin süreler yayından önce burada listelenecek.',
          ],
        },
        {
          heading: 'Seçeneklerin ve hakların',
          body: [
            'Uygulamada profilini düzenleyebilir, mesafeni veya yaşını gizleyebilir, hesabını duraklatabilir, verilerini indirebilir ve hesabını silebilirsin. Verilerine erişmek, düzeltmek veya silmek için {supportEmail} adresine de yazabilirsin.',
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
      title: 'Child Safety Standards',
      description: '{appName} has zero tolerance for child sexual abuse and exploitation (CSAE).',
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
          heading: 'Prevention and reporting',
          body: [
            'Photos are checked before other members can see them. Anyone can report a profile or a message from inside the app, and reports about child safety are handled before all others.',
          ],
        },
        {
          heading: 'Working with the authorities',
          body: [
            'We report child sexual abuse material and child exploitation to the competent authorities, such as the National Center for Missing & Exploited Children (NCMEC) or the national authority where the law requires it, and we preserve the evidence the law requires.',
          ],
        },
        {
          heading: 'Child safety contact',
          body: ['Write to {supportEmail}. If a child is in immediate danger, call your local emergency number first.'],
        },
      ],
    },
    fa: {
      title: 'استانداردهای ایمنی کودکان',
      description: '{appName} در برابر سوءاستفاده و بهره‌کشی جنسی از کودکان (CSAE) هیچ تحملی ندارد.',
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
          heading: 'پیشگیری و گزارش',
          body: [
            'عکس‌ها پیش از آن‌که دیگر کاربران ببینندشان بررسی می‌شوند. هر کسی می‌تواند از داخل اپ یک پروفایل یا پیام را گزارش کند و گزارش‌های مربوط به ایمنی کودکان پیش از همه رسیدگی می‌شوند.',
          ],
        },
        {
          heading: 'همکاری با مراجع قانونی',
          body: [
            'محتوای سوءاستفاده‌ی جنسی از کودکان و بهره‌کشی از کودکان را به مراجع صلاحیت‌دار، مانند National Center for Missing & Exploited Children (NCMEC) یا مرجع ملی هر جا که قانون الزام کند، گزارش می‌دهیم و شواهد را طبق الزام قانون نگه می‌داریم.',
          ],
        },
        {
          heading: 'تماس درباره‌ی ایمنی کودکان',
          body: ['به {supportEmail} بنویسید. اگر کودکی در خطر فوری است، اول با شماره‌ی اضطراری محلی تماس بگیرید.'],
        },
      ],
    },
    tr: {
      title: 'Çocuk Güvenliği Standartları',
      description: '{appName}, çocukların cinsel istismarına ve sömürüsüne (CSAE) karşı sıfır tolerans uygular.',
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
          heading: 'Önleme ve bildirme',
          body: [
            'Fotoğraflar diğer üyeler görmeden önce kontrol edilir. Herkes uygulamanın içinden bir profili veya mesajı bildirebilir; çocuk güvenliğiyle ilgili bildirimler herkesten önce ele alınır.',
          ],
        },
        {
          heading: 'Resmî makamlarla iş birliği',
          body: [
            'Çocuk cinsel istismarı materyalini ve çocuk sömürüsünü, National Center for Missing & Exploited Children (NCMEC) gibi yetkili makamlara veya yasanın gerektirdiği yerde ulusal makama bildiririz ve yasanın gerektirdiği delilleri saklarız.',
          ],
        },
        {
          heading: 'Çocuk güvenliği iletişimi',
          body: ['{supportEmail} adresine yaz. Bir çocuk acil tehlikedeyse önce yerel acil durum numarasını ara.'],
        },
      ],
    },
  },
};

const deleteAccount: SitePage = {
  draft: true,
  content: {
    en: {
      title: 'Delete your account',
      description: 'How to delete your {appName} account, with or without the app, and what happens to your data.',
      sections: [
        {
          heading: 'In the app (fastest)',
          body: ['Your profile disappears from {appName} as soon as you confirm.'],
          list: ['Open {appName}.', 'Go to Settings, then Account, then Delete account.', 'Confirm.'],
          ordered: true,
        },
        {
          heading: 'Without the app',
          body: [
            'E-mail {supportEmail} with the subject “Delete my account”, from the e-mail address of your account, or tell us the phone number you signed up with. We confirm with you before deleting, so nobody can delete your account but you.',
          ],
        },
        { heading: 'What is deleted', body: ['Your profile, photos, prompts, likes, matches and messages.'] },
        {
          heading: 'What is kept, and for how long',
          body: [
            'Purchase records that tax law requires, and records of safety actions (for example a ban for abuse) so that a banned person cannot simply come back. They are kept only as long as the law requires; the exact periods will be listed here before launch.',
          ],
        },
        {
          heading: 'Subscriptions',
          body: [
            'Deleting your account does not cancel a subscription. Cancel it first in the settings of the store you bought it from (Google Play, Cafe Bazaar or the App Store).',
          ],
        },
      ],
    },
    fa: {
      title: 'حذف حساب کاربری',
      description: 'چگونه حساب {appName} خود را، با اپ یا بدون آن، حذف کنید و چه بر سر داده‌هایتان می‌آید.',
      sections: [
        {
          heading: 'در اپ (سریع‌ترین راه)',
          body: ['پروفایل شما بلافاصله پس از تأیید از {appName} ناپدید می‌شود.'],
          list: ['{appName} را باز کنید.', 'به تنظیمات، سپس حساب، سپس حذف حساب بروید.', 'تأیید کنید.'],
          ordered: true,
        },
        {
          heading: 'بدون اپ',
          body: [
            'از ایمیل حساب خود به {supportEmail} با موضوع «حذف حساب کاربری من» ایمیل بزنید، یا شماره‌ای را که با آن ثبت‌نام کرده‌اید بنویسید. پیش از حذف با شما تأیید می‌کنیم تا هیچ‌کس جز خودتان نتواند حسابتان را حذف کند.',
          ],
        },
        { heading: 'چه چیزی حذف می‌شود', body: ['پروفایل، عکس‌ها، پاسخ پرسش‌ها، لایک‌ها، مچ‌ها و پیام‌های شما.'] },
        {
          heading: 'چه چیزی و تا کی نگه داشته می‌شود',
          body: [
            'سوابق خرید که قانون مالیات الزامی می‌کند، و سوابق اقدامات ایمنی (مثلاً محرومیت به دلیل آزار) تا فرد محروم‌شده به‌سادگی برنگردد. این‌ها فقط به مدتی که قانون الزام می‌کند نگه داشته می‌شوند؛ مدت‌های دقیق پیش از راه‌اندازی این‌جا اعلام می‌شود.',
          ],
        },
        {
          heading: 'اشتراک‌ها',
          body: [
            'حذف حساب، اشتراک را لغو نمی‌کند. اول آن را در تنظیمات فروشگاهی که از آن خریده‌اید (Google Play، کافه‌بازار یا App Store) لغو کنید.',
          ],
        },
      ],
    },
    tr: {
      title: 'Hesabını sil',
      description: '{appName} hesabını uygulamayla veya uygulama olmadan nasıl sileceğin ve verilerine ne olacağı.',
      sections: [
        {
          heading: 'Uygulamada (en hızlısı)',
          body: ['Onayladığın anda profilin {appName} uygulamasından kaybolur.'],
          list: ['{appName} uygulamasını aç.', 'Ayarlar, ardından Hesap, ardından Hesabı sil bölümüne git.', 'Onayla.'],
          ordered: true,
        },
        {
          heading: 'Uygulama olmadan',
          body: [
            'Hesabının e-posta adresinden {supportEmail} adresine “Hesabımı sil” konulu bir e-posta gönder ya da kayıt olduğun telefon numarasını bize bildir. Hesabını senden başka kimsenin silememesi için silmeden önce seninle teyit ederiz.',
          ],
        },
        { heading: 'Neler silinir', body: ['Profilin, fotoğrafların, yanıtların, beğenilerin, eşleşmelerin ve mesajların.'] },
        {
          heading: 'Neler, ne kadar süre saklanır',
          body: [
            'Vergi mevzuatının gerektirdiği satın alma kayıtları ve yasaklanan birinin kolayca geri dönememesi için güvenlik işlemlerinin kayıtları (örneğin taciz nedeniyle verilen bir yasak). Bunlar yalnızca yasanın gerektirdiği süre boyunca saklanır; kesin süreler yayından önce burada listelenecek.',
          ],
        },
        {
          heading: 'Abonelikler',
          body: [
            'Hesabını silmek aboneliği iptal etmez. Önce satın aldığın mağazanın ayarlarından (Google Play, Cafe Bazaar veya App Store) iptal et.',
          ],
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
      description: 'How to reach the {appName} team.',
      sections: [
        { heading: 'Write to us', body: ['E-mail {supportEmail}. You can write in Persian, English or Turkish.'] },
        {
          heading: 'A safety problem',
          body: [
            'Use Report on the person’s profile or in your conversation; reports reach our moderation team directly. If someone is in danger, call your local emergency number first.',
          ],
        },
        {
          heading: 'Purchases and refunds',
          body: [
            'Purchases are made through your app store, and refunds follow its rules. If a purchase does not show up in the app, use Restore purchases in the app’s subscription settings, or write to us with the store’s receipt.',
          ],
        },
        { heading: 'Deleting your account', body: ['See how to delete your account, with or without the app: {deleteAccountPath}'] },
      ],
    },
    fa: {
      title: 'پشتیبانی',
      description: 'راه‌های تماس با تیم {appName}.',
      sections: [
        { heading: 'به ما بنویسید', body: ['به {supportEmail} ایمیل بزنید. می‌توانید به فارسی، انگلیسی یا ترکی بنویسید.'] },
        {
          heading: 'مشکل ایمنی',
          body: [
            'از گزینه‌ی گزارش در پروفایل آن فرد یا در گفتگو استفاده کنید؛ گزارش مستقیم به تیم نظارت ما می‌رسد. اگر کسی در خطر است، اول با شماره‌ی اضطراری محلی تماس بگیرید.',
          ],
        },
        {
          heading: 'خرید و بازپرداخت',
          body: [
            'خریدها از طریق فروشگاه اپ شما انجام می‌شوند و بازپرداخت طبق قوانین آن است. اگر خریدی در اپ دیده نمی‌شود، در تنظیمات اشتراک اپ «بازیابی خرید» را بزنید یا با رسید فروشگاه به ما بنویسید.',
          ],
        },
        { heading: 'حذف حساب', body: ['روش حذف حساب، با اپ یا بدون آن: {deleteAccountPath}'] },
      ],
    },
    tr: {
      title: 'Destek',
      description: '{appName} ekibine nasıl ulaşılır.',
      sections: [
        { heading: 'Bize yaz', body: ['{supportEmail} adresine e-posta gönder. Farsça, İngilizce veya Türkçe yazabilirsin.'] },
        {
          heading: 'Bir güvenlik sorunu',
          body: [
            'Kişinin profilinde veya sohbetinizde Bildir’i kullan; bildirimler doğrudan denetim ekibimize ulaşır. Biri tehlikedeyse önce yerel acil durum numarasını ara.',
          ],
        },
        {
          heading: 'Satın almalar ve iadeler',
          body: [
            'Satın almalar uygulama mağazan üzerinden yapılır ve iadeler onun kurallarına tabidir. Bir satın alma uygulamada görünmüyorsa uygulamanın abonelik ayarlarındaki Satın alımları geri yükle seçeneğini kullan ya da mağaza makbuzuyla bize yaz.',
          ],
        },
        { heading: 'Hesabını silmek', body: ['Hesabını uygulamayla veya uygulama olmadan nasıl sileceğin: {deleteAccountPath}'] },
      ],
    },
  },
};

export const sitePages: Readonly<Record<PageSlug, SitePage>> = {
  privacy,
  terms,
  'community-guidelines': communityGuidelines,
  'child-safety': childSafety,
  'delete-account': deleteAccount,
  support,
};
