import { motion, type Variants } from "framer-motion";
import { ReceiptText, Store } from "lucide-react";
import { BrandLogo } from "~/components/app/brand-logo";
import ShopifyIcon from "~/assests/icon/shopifyIcon";
import WhatsappIcon from "~/assests/icon/whatsappIcon";

const container: Variants = {
    hidden: {},
    visible: {
        transition: { staggerChildren: 0.12, delayChildren: 0.1 },
    },
};

const channelPop: Variants = {
    hidden: { opacity: 0, scale: 0.6 },
    visible: {
        opacity: 1,
        scale: 1,
        transition: { duration: 0.45, ease: "backOut" },
    },
};

const lineDraw: Variants = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
        pathLength: 1,
        opacity: 1,
        transition: { duration: 0.55, ease: "easeInOut" },
    },
};

// Hub appears last via its own delay so the lines visibly "feed into" it
const hubPop: Variants = {
    hidden: { opacity: 0, scale: 0.4 },
    visible: {
        opacity: 1,
        scale: 1,
        transition: { duration: 0.5, ease: "backOut", delay: 0.85 },
    },
};

export function UnifiedCommerceIllustration() {
    return (
        <motion.div
            variants={container}
            initial="hidden"
            animate="visible"
            className="relative mx-auto aspect-[16/9] w-full max-w-[360px]"
        >
            {/* Connecting lines (under chips) */}
            <svg
                viewBox="0 0 360 200"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full text-white/30"
                fill="none"
            >
                <motion.path
                    d="M 60 40 L 180 100"
                    stroke="currentColor"
                    strokeWidth="1"
                    variants={lineDraw}
                />
                <motion.path
                    d="M 300 40 L 180 100"
                    stroke="currentColor"
                    strokeWidth="1"
                    variants={lineDraw}
                />
                <motion.path
                    d="M 60 160 L 180 100"
                    stroke="currentColor"
                    strokeWidth="1"
                    variants={lineDraw}
                />
                <motion.path
                    d="M 300 160 L 180 100"
                    stroke="currentColor"
                    strokeWidth="1"
                    variants={lineDraw}
                />
            </svg>

            {/* Top-left — Shopify */}
            <motion.div
                variants={channelPop}
                className="absolute left-0 top-0 flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-md shadow-black/20 ring-1 ring-black/5"
            >
                <ShopifyIcon className="size-3 text-[#3B82F6]" fill="currentColor" width={15} height={15} />
                <span className="text-[10px] font-medium text-gray-900">Shopify</span>
            </motion.div>

            {/* Top-right — WhatsApp */}
            <motion.div
                variants={channelPop}
                className="absolute right-0 top-0 flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-md shadow-black/20 ring-1 ring-black/5"
            >
                <WhatsappIcon width={15} height={15} />
                <span className="text-[10px] font-medium text-gray-900">WhatsApp</span>
            </motion.div>

            {/* Bottom-left — the counter (point of sale) */}
            <motion.div
                variants={channelPop}
                className="absolute left-0 bottom-0 flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-md shadow-black/20 ring-1 ring-black/5"
            >
                <Store className="size-[15px] text-gray-900" />
                <span className="text-[10px] font-medium text-gray-900">In-store</span>
            </motion.div>

            {/* Bottom-right — GST invoices */}
            <motion.div
                variants={channelPop}
                className="absolute right-0 bottom-0 flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-md shadow-black/20 ring-1 ring-black/5"
            >
                <ReceiptText className="size-[15px] text-gray-900" />
                <span className="text-[10px] font-medium text-gray-900">GST invoices</span>
            </motion.div>

            {/* Central hub — Collabo */}
            <motion.div
                variants={hubPop}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 rounded-full bg-[#CEF17B] px-3 py-1.5 shadow-lg shadow-[#CEF17B]/30 ring-2 ring-white/20"
            >
                <BrandLogo variant="forest" className="h-3" />
            </motion.div>
        </motion.div>
    );
}