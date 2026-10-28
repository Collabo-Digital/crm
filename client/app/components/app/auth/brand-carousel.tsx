import { useState, useEffect, type ReactNode } from "react";

export interface BrandSlide {
    /** Title — pass plain string OR JSX (use <span className="text-brand">…</span> for accent). */
    title: ReactNode;
    /** Subtitle copy beneath the title. */
    subtitle: string;
    /** Optional illustration rendered beneath the subtitle. Should accept its own internal animation. */
    illustration?: ReactNode;
}

interface BrandCarouselProps {
    slides?: BrandSlide[];
    /** Auto-advance interval in ms. Default 5000. */
    intervalMs?: number;
    className?: string;
}

// Imported lazily inside the default array to avoid circular concerns
import { AutomatedWorkflowIllustration } from "./illustrations/automated-workflow";
import { CustomerProfileIllustration } from "./illustrations/customer-profile";
import { UnifiedCommerceIllustration } from "./illustrations/unified-commerce";

// What launches: Shopify, the counter (point of sale), WhatsApp and GST
// invoices. Nothing here may promise a channel the product doesn't have.
const DEFAULT_SLIDES: BrandSlide[] = [
    {
        title: (
            <>
                Unified Commerce,
                <br />
                <span className="text-brand">Simplified.</span>
            </>
        ),
        subtitle:
            "Shopify orders, counter sales, WhatsApp chats and GST invoices, in one place.",
        illustration: <UnifiedCommerceIllustration />,
    },
    {
        title: "Automated workflows",
        subtitle: "Order updates, cash-on-delivery checks and cart reminders go out on WhatsApp by themselves.",
        illustration: <AutomatedWorkflowIllustration />,
    },
    {
        title: (
            <>
                Every order,
                <br />
                <span className="text-brand">One View.</span>
            </>
        ),
        subtitle:
            "Shopify and in-store orders land in one dashboard you can run from anywhere.",
        illustration: <CustomerProfileIllustration />,
    },
    {
        title: (
            <>
                Conversations,
                <br />
                <span className="text-brand">Centralised.</span>
            </>
        ),
        subtitle:
            "Every WhatsApp chat in one shared inbox, with the customer's orders beside it.",
        illustration: <CustomerProfileIllustration />,
    },
];

export function BrandCarousel({
    slides = DEFAULT_SLIDES,
    intervalMs = 5000,
    className = "",
}: BrandCarouselProps) {
    const [activeIndex, setActiveIndex] = useState(0);
    const [isPaused, setIsPaused] = useState(false);

    useEffect(() => {
        if (isPaused || slides.length <= 1) return;
        const id = setInterval(() => {
            setActiveIndex((i) => (i + 1) % slides.length);
        }, intervalMs);
        return () => clearInterval(id);
    }, [isPaused, slides.length, intervalMs]);

    const slide = slides[activeIndex];

    return (
        <div
            // onMouseEnter={() => setIsPaused(true)}
            // onMouseLeave={() => setIsPaused(false)}
            className={`relative flex flex-col  p-10 ${className}`}
        >
            {/* Decorative glow blobs */}
            <div className="pointer-events-none absolute -top-32 -left-32 size-96 rounded-full bg-brand/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-32 -right-16 size-72 rounded-full bg-brand/8 blur-3xl" />

            {/* Dash indicators */}
            <div className="relative flex items-center justify-center gap-2">
                {slides.map((_, i) => (
                    <button
                        key={i}
                        type="button"
                        aria-label={`Go to slide ${i + 1}`}
                        aria-current={i === activeIndex}
                        onClick={() => setActiveIndex(i)}
                        className={`h-[2px] rounded-full transition-all duration-500 ${i === activeIndex
                            ? "w-10 bg-white"
                            : "w-6 bg-white/30 hover:bg-white/60"
                            }`}
                    />
                ))}
            </div>

            {/* Slide content — key forces remount so animations re-fire */}
            <div
                key={activeIndex}
                className="relative flex flex-1 flex-col items-center justify-center px-4 text-center"
            >
                <h2 className="animate-in fade-in slide-in-from-bottom-2 duration-700 text-3xl font-bold leading-tight text-white md:text-4xl">
                    {slide.title}
                </h2>
                <p className="animate-in fade-in slide-in-from-bottom-2 duration-700 mt-4 max-w-sm text-sm leading-relaxed text-white/70">
                    {slide.subtitle}
                </p>

                {slide.illustration && (
                    <div className="mt-8 w-full max-w-sm">{slide.illustration}</div>
                )}
            </div>
        </div>
    );
}