     (function () {
      const logo = document.querySelector(".logo");
      const heroOrb = document.querySelector(".hero-orb");
      const orbText = document.querySelector(".orb-text");
      const newsletterForm = document.querySelector(".newsletter-form");
      const newsletterEmail = document.querySelector("#newsletter-email");
      const newsletterStatus = document.querySelector(".newsletter-status");
      const newsletterButton = newsletterForm ? newsletterForm.querySelector('button[type="submit"]') : null;
      if (!logo || !heroOrb || !orbText) return;

      // Texts come from i18n/en.js and i18n/fr.js (the HTML values are the fallback)
      const T = (key, fallback) => (window.ST_I18N ? window.ST_I18N.t(key) : fallback);
      let fullText = T("home.orb", (orbText.getAttribute("data-text") || "").trim());
      const typingSpeed = 112;
      let timer = null;
      let isPinned = false;
      let newsletterPending = false;
      const pageOpenedAt = Date.now();

      // Address of the Brevo form, kept out of the HTML and stored reversed in pieces so that robots
      // harvesting form addresses do not find it. It is rebuilt only when someone presses the button.
      // To change the form: reverse the new token (the part after /serve/) and split it again.
      function newsletterUrl() {
        const pieces = [
          "==wgZNpClhqxCo2sQ0FODtvzl5ZOKTAD45lY",
          "AVpL0ojpMiNuCzMe36kTL6QVv0wEiWxHq1Zs",
          "DswWIF-RlRyIBdisVbHFJPtA8TjP-A_kC3gs",
          "iucWCQ03itv100qWu5oNylCiT-qtBepPO-qY",
          "RhWGzgLe3dhPF1NadB4q4l_sdIZggbFAcKsr",
          "FnB7hGNMRdCA2Ag-XHap-p07dPKAFIUM"
        ];
        return ["https:", "", "360af059.sibforms.com", "serve", pieces.join("").split("").reverse().join("")].join("/");
      }

      function reset() {
        if (isPinned) return;
        if (timer) clearInterval(timer);
        timer = null;
        orbText.textContent = "";
        orbText.classList.remove("is-typing");
      }

      function type() {
        if (isPinned) return;
        reset();
        orbText.classList.add("is-typing");
        let i = 0;
        timer = setInterval(() => {
          orbText.textContent = fullText.slice(0, i);
          i += 1;
          if (i > fullText.length) {
            clearInterval(timer);
            timer = null;
            orbText.classList.remove("is-typing");
            orbText.classList.add("is-done"); // text complete: CSS eases it down 5%
            isPinned = true;
            document.body.classList.add("orb-active");
          }
        }, typingSpeed);
      }

      function pinAndType(event) {
        if (event) event.preventDefault();
        if (isPinned) return;
        document.body.classList.add("orb-active");
        type();
      }

      function finishNewsletterSubmission(message, shouldReset) {
        newsletterPending = false;
        if (newsletterButton) newsletterButton.disabled = false;
        if (newsletterStatus) newsletterStatus.textContent = message;
        if (shouldReset && newsletterForm) newsletterForm.reset();
      }

      window.setTimeout(() => {
        pinAndType();
      }, 1500);

      // Language switched: the orb shows the new text (in full if it was already typed)
      document.addEventListener("st:lang", () => {
        fullText = T("home.orb", fullText);
        if (isPinned) orbText.textContent = fullText;
      });

      logo.addEventListener("click", pinAndType);
      heroOrb.addEventListener("click", pinAndType);

      if (newsletterForm && newsletterEmail && newsletterStatus) {
        newsletterForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (newsletterPending) return;
          const email = newsletterEmail.value.trim();
          newsletterEmail.value = email;

          if (!newsletterEmail.checkValidity()) {
            newsletterStatus.textContent = T("home.nlInvalid", "Please enter a valid email address.");
            return;
          }

          // Robot filters: trap field filled, or form sent less than 3 s after the page opened.
          // The robot gets the normal "sent" message, so it learns nothing; nothing goes to Brevo.
          const trap = newsletterForm.querySelector('input[name="website"]');
          if ((trap && trap.value) || Date.now() - pageOpenedAt < 3000) {
            finishNewsletterSubmission(T("home.nlSent", "Request sent."), true);
            return;
          }

          newsletterPending = true;
          if (newsletterButton) newsletterButton.disabled = true;
          newsletterStatus.textContent = T("home.nlSending", "Sending your request to the newsletter service...");

          const body = new URLSearchParams({
            EMAIL: email,
            email_address_check: "",
            locale: window.ST_I18N ? window.ST_I18N.lang : "en",
          });
          try {
            const res = await fetch(newsletterUrl(), { method: "POST", body });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
              finishNewsletterSubmission(T("home.nlSent", "Request sent. Check your inbox and spam folder to confirm your subscription."), true);
            } else {
              finishNewsletterSubmission(T("home.nlError", "The subscription could not be sent. Please try again in a few minutes."), false);
            }
          } catch (_) {
            finishNewsletterSubmission(T("home.nlError", "The subscription could not be sent. Please try again in a few minutes."), false);
          }
        });
      }
    })();
  
