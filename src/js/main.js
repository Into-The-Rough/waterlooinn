/* ============================================
   THE WATERLOO INN - Main JavaScript
   ============================================ */

(function () {
    'use strict';

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

    // --- Gallery lightbox ---
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxClose = document.querySelector('.lightbox-close');
    const lightboxPrev = document.querySelector('.lightbox-prev');
    const lightboxNext = document.querySelector('.lightbox-next');
    const galleryItems = document.querySelectorAll('.gallery-item');

    let currentIndex = 0;
    var gallerySources = [];

    galleryItems.forEach(function (item, index) {
        var img = item.querySelector('img');
        if (img) {
            gallerySources.push({
                src: img.src,
                alt: img.alt
            });

            item.addEventListener('click', function () {
                currentIndex = index;
                openLightbox();
            });
        }
    });

    function openLightbox() {
        if (gallerySources.length === 0) return;
        lightboxImg.src = gallerySources[currentIndex].src;
        lightboxImg.alt = gallerySources[currentIndex].alt;
        lightbox.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeLightbox() {
        lightbox.classList.remove('active');
        document.body.style.overflow = '';
    }

    function nextImage() {
        currentIndex = (currentIndex + 1) % gallerySources.length;
        lightboxImg.src = gallerySources[currentIndex].src;
        lightboxImg.alt = gallerySources[currentIndex].alt;
    }

    function prevImage() {
        currentIndex = (currentIndex - 1 + gallerySources.length) % gallerySources.length;
        lightboxImg.src = gallerySources[currentIndex].src;
        lightboxImg.alt = gallerySources[currentIndex].alt;
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
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowRight') nextImage();
        if (e.key === 'ArrowLeft') prevImage();
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
