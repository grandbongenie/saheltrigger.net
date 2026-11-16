     (function () {
      const logo = document.querySelector(".logo");
      const heroOrb = document.querySelector(".hero-orb");
      const orbText = document.querySelector(".orb-text");
      const newsletterForm = document.querySelector(".newsletter-form");
      const newsletterEmail = document.querySelector("#newsletter-email");
      const newsletterStatus = document.querySelector(".newsletter-status");
      const newsletterButton = newsletterForm ? newsletterForm.querySelector('button[type="submit"]') : null;
      const newsletterFrame = document.querySelector('iframe[name="newsletter-submit-frame"]');
      if (!logo || !heroOrb || !orbText) return;

      // Texts come from i18n/en.js and i18n/fr.js (the HTML values are the fallback)
      const T = (key, fallback) => (window.ST_I18N ? window.ST_I18N.t(key) : fallback);
      let fullText = T("home.orb", (orbText.getAttribute("data-text") || "").trim());
      const typingSpeed = 112;
      let timer = null;
      let isPinned = false;
      let newsletterPending = false;
      let newsletterFallbackTimer = null;

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
        if (newsletterFallbackTimer) {
          clearTimeout(newsletterFallbackTimer);
          newsletterFallbackTimer = null;
        }
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

      if (newsletterFrame) {
        newsletterFrame.addEventListener("load", () => {
          if (!newsletterPending) return;
          finishNewsletterSubmission(
            T("home.nlSent", "Request sent. Check your inbox and spam folder to confirm your subscription."),
            true
          );
        });
      }

      if (newsletterForm && newsletterEmail && newsletterStatus) {
        newsletterForm.addEventListener("submit", (event) => {
          const email = newsletterEmail.value.trim();

          if (!newsletterEmail.checkValidity()) {
            event.preventDefault();
            newsletterStatus.textContent = T("home.nlInvalid", "Please enter a valid email address.");
            return;
          }

          newsletterPending = true;
          if (newsletterButton) newsletterButton.disabled = true;
          newsletterStatus.textContent = T("home.nlSending", "Sending your request to the newsletter service...");

          newsletterFallbackTimer = window.setTimeout(() => {
            if (!newsletterPending) return;
            finishNewsletterSubmission(
              T("home.nlRetry", "If nothing arrived after a few minutes, please try again. Check your inbox and spam folder."),
              false
            );
          }, 12000);

          newsletterEmail.value = email;
        });
      }
    })();
  
