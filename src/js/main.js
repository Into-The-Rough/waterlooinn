/* ============================================
   THE WATERLOO INN - Main JavaScript
   ============================================ */

(function () {
    'use strict';

    // Netlify Identity invitation and recovery emails return to the public site.
    // Carry the token to the admin page, where the Identity widget can complete it.
    if (/^#(?:invite_token|recovery_token|confirmation_token|email_change_token)=/.test(window.location.hash)) {
        window.location.replace('/admin/' + window.location.hash);
        return;
    }

    // The booking links start hidden in the HTML and are only revealed after
    // the durable server-side master switch has been checked successfully.
    fetch('/api/booking-status', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
    }).then(function (response) {
        if (!response.ok) throw new Error('Booking status unavailable');
        return response.json();
    }).then(function (state) {
        document.documentElement.dataset.onlineBookings = state.enabled ? 'open' : 'closed';
    }).catch(function () {
        document.documentElement.dataset.onlineBookings = 'closed';
    });

    // --- Header scroll effect ---
    const header = document.getElementById('header');

    function updateHeader() {
        if (window.scrollY > 60) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    }

    window.addEventListener('scroll', updateHeader, { passive: true });
    updateHeader();

    // --- Mobile menu toggle ---
    const menuToggle = document.getElementById('menuToggle');
    const navLinks = document.getElementById('navLinks');

    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', function () {
            menuToggle.classList.toggle('active');
            navLinks.classList.toggle('open');
        });

        // Close menu when a link is clicked
        navLinks.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                menuToggle.classList.remove('active');
                navLinks.classList.remove('open');
            });
        });
    }

    // --- Shared gallery/event image viewer ---
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxClose = document.querySelector('.lightbox-close');
    const lightboxPrev = document.querySelector('.lightbox-prev');
    const lightboxNext = document.querySelector('.lightbox-next');
    const galleryItems = document.querySelectorAll('.gallery-item');

    let currentIndex = 0;
    var gallerySources = [];
    var currentSources = [];
    var returnFocus = null;
    var previousBodyOverflow = '';

    galleryItems.forEach(function (item) {
        var img = item.querySelector('img');
        if (img) {
            var index = gallerySources.push({
                src: img.src,
                alt: img.alt
            }) - 1;

            item.addEventListener('click', function () {
                openLightbox(gallerySources, index);
            });
        }
    });

    document.querySelectorAll('[data-event-image]').forEach(function (link) {
        link.addEventListener('click', function (e) {
            // Leave the original-image link working when the viewer is unavailable.
            if (!lightbox || !lightboxImg || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            var img = link.querySelector('img');
            if (!img) return;
            e.preventDefault();
            openLightbox([{ src: link.href, alt: img.alt }], 0, link);
        });
    });

    function openLightbox(sources, index, trigger) {
        if (!lightbox || !lightboxImg || sources.length === 0) return;
        currentSources = sources;
        currentIndex = index;
        returnFocus = trigger || document.activeElement;
        previousBodyOverflow = document.body.style.overflow;
        lightboxImg.src = currentSources[currentIndex].src;
        lightboxImg.alt = currentSources[currentIndex].alt;
        if (lightboxPrev) lightboxPrev.hidden = currentSources.length <= 1;
        if (lightboxNext) lightboxNext.hidden = currentSources.length <= 1;
        lightbox.classList.add('active');
        lightbox.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        (lightboxClose || lightbox).focus();
    }

    function closeLightbox() {
        if (!lightbox || !lightbox.classList.contains('active')) return;
        lightbox.classList.remove('active');
        lightbox.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = previousBodyOverflow;
        if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    }

    function nextImage() {
        if (currentSources.length <= 1) return;
        currentIndex = (currentIndex + 1) % currentSources.length;
        lightboxImg.src = currentSources[currentIndex].src;
        lightboxImg.alt = currentSources[currentIndex].alt;
    }

    function prevImage() {
        if (currentSources.length <= 1) return;
        currentIndex = (currentIndex - 1 + currentSources.length) % currentSources.length;
        lightboxImg.src = currentSources[currentIndex].src;
        lightboxImg.alt = currentSources[currentIndex].alt;
    }

    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    if (lightboxNext) lightboxNext.addEventListener('click', nextImage);
    if (lightboxPrev) lightboxPrev.addEventListener('click', prevImage);

    if (lightbox) {
        lightbox.addEventListener('click', function (e) {
            if (e.target === lightbox) closeLightbox();
        });
    }

    // Keyboard navigation for lightbox
    document.addEventListener('keydown', function (e) {
        if (!lightbox || !lightbox.classList.contains('active')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeLightbox();
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            if (e.key === 'ArrowRight') nextImage();
            else prevImage();
        }
        if (e.key === 'Tab') {
            var controls = [lightboxClose, lightboxPrev, lightboxNext].filter(function (control) {
                return control && !control.hidden;
            });
            if (controls.length === 0) {
                e.preventDefault();
                lightbox.focus();
                return;
            }
            var first = controls[0];
            var last = controls[controls.length - 1];
            if (!lightbox.contains(document.activeElement) ||
                (e.shiftKey && document.activeElement === first) ||
                (!e.shiftKey && document.activeElement === last)) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
        }
    });

    // --- Smooth scroll for anchor links ---
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            var targetId = this.getAttribute('href');
            if (targetId === '#') return;
            var target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                var headerHeight = header.offsetHeight;
                var targetPosition = target.getBoundingClientRect().top + window.scrollY - headerHeight;
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // --- Fade-in on scroll (Intersection Observer) ---
    var animatedElements = document.querySelectorAll(
        '.welcome-text, .welcome-image, .feature-item, .beer-garden-content, ' +
        '.food-text, .food-images, .campsite-text, .campsite-image, .contact-info, .contact-map'
    );

    if ('IntersectionObserver' in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.15 });

        animatedElements.forEach(function (el) {
            el.style.opacity = '0';
            el.style.transform = 'translateY(30px)';
            el.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
            observer.observe(el);
        });
    }

})();
