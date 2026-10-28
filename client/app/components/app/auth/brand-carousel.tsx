import { useState, useEffect, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";

import { useMediaQuery } from "~/hooks/use-media-query";

export interface BrandSlide {
    /** Title — pass plain string OR JSX (use <span className="text-[#CEF17B]">…</span> for accent). */
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

const DEFAULT_SLIDES: BrandSlide[] = [
    {
        title: (
            <>
                Unified Commerce,
                <br />
                <span className="text-[#CEF17B]">Simplified.</span>
            </>
        ),
        subtitle:
            "One platform for orders, customers, marketing, and conversations — across every channel you sell on.",
        illustration: <UnifiedCommerceIllustration />,
    },
    {
        title: "Automated workflows",
        subtitle: "Reduce manual tasks so you can focus on growth.",
        illustration: <AutomatedWorkflowIllustration />,
    },
    {
        title: (
            <>
                All Channels,
                <br />
                <span className="text-[#CEF17B]">One View.</span>
            </>
        ),
        subtitle:
            "Shopify, Amazon, and offline orders sync into a single dashboard you can manage from anywhere.",
        illustration: <CustomerProfileIllustration />,
    },
    {
        title: (
            <>
                Conversations,
                <br />
                <span className="text-[#CEF17B]">Centralised.</span>
            </>
        ),
        subtitle:
            "Email, chat, WhatsApp and social messages in one inbox — never miss a customer touchpoint.",
        illustration: <CustomerProfileIllustration />,
    },
];

export function BrandCarousel({
    slides = DEFAULT_SLIDES,
    intervalMs = 5000,
    className = "",
}: BrandCarouselProps) {
    const [activeIndex, setActiveIndex] = useState(0);
    // Moving content must be possible to pause (WCAG 2.2.2): the button stops
    // it, and it holds while the pointer or keyboard focus is on it. With
    // reduce motion on, it waits for Play.
    const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const [playChoice, setPlayChoice] = useState<boolean | null>(null);
    const playing = playChoice ?? !reduceMotion;
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!playing || hovered || focused || slides.length <= 1) return;
        const id = setInterval(() => {
            setActiveIndex((i) => (i + 1) % slides.length);
        }, intervalMs);
        return () => clearInterval(id);
    }, [playing, hovered, focused, slides.length, intervalMs]);

    const slide = slides[activeIndex];

    return (
        <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
            }}
            className={`relative flex flex-col  p-10 ${className}`}
        >
            {/* Decorative glow blobs */}
            <div className="pointer-events-none absolute -top-32 -left-32 size-96 rounded-full bg-[#CEF17B]/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-32 -right-16 size-72 rounded-full bg-[#CEF17B]/8 blur-3xl" />

            {/* Dash indicators */}
            <div className="relative flex items-center justify-center gap-2">
                {slides.map((_, i) => (
                    <button
                        key={i}
                        type="button"
                        aria-label={`Go to slide ${i + 1}`}
                        aria-current={i === activeIndex}
                        onClick={() => setActiveIndex(i)}
                        // A 24px target round the 2px dash.
                        className="group flex h-6 items-center focus-visible:outline-white"
                    >
                        <span
                            className={`block h-[2px] rounded-full transition-all duration-500 ${i === activeIndex
                                ? "w-10 bg-white"
                                : "w-6 bg-white/30 group-hover:bg-white/60"
                                }`}
                        />
                    </button>
                ))}
                {slides.length > 1 && (
                    <button
                        type="button"
                        onClick={() => setPlayChoice(!playing)}
                        aria-label={playing ? "Pause slides" : "Play slides"}
                        className="ml-1 flex size-6 items-center justify-center rounded-full text-white/70 hover:text-white focus-visible:outline-white"
                    >
                        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                    </button>
                )}
            </div>

            {/* Slide content — key forces remount so animations re-fire */}
            <div
                key={activeIndex}
                className="relative flex flex-1 flex-col items-center justify-center px-4 text-center"
            >
                <p className="animate-in fade-in slide-in-from-bottom-2 duration-700 text-3xl font-bold leading-tight text-white md:text-4xl">
                    {slide.title}
                </p>
                <p className="animate-in fade-in slide-in-from-bottom-2 duration-700 mt-4 max-w-sm text-sm leading-relaxed text-gray-400">
                    {slide.subtitle}
                </p>

                {slide.illustration && (
                    <div className="mt-8 w-full max-w-sm">{slide.illustration}</div>
                )}
            </div>
        </div>
    );
}