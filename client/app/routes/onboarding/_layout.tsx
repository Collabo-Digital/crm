import { Outlet, useLocation } from "react-router";
import { OnboardingGuard } from "~/components/guards/onboarding-guard";
import OrganizationStepIcon from "~/assests/onboarding/organization";
import ConnectIcon from "~/assests/onboarding/step2/connectIcon";
import CustomerIcon from "~/assests/onboarding/step2/customerIcon";
import ScaleIcon from "~/assests/onboarding/step2/scaleIcon";
import CubeIcon from "~/assests/onboarding/step1/cubeIcon";
import TeamIcon from "~/assests/onboarding/step1/teamIcon";
import InviteIcon from "~/assests/onboarding/step3/inviteIcon";

const STEP_CONFIG = {
  "choose-plan": {
    features: [
      {
        icon: ScaleIcon,
        title: "Flexible Plans",
        description: "Pick a plan that fits your business size and upgrade anytime.",
      },
      {
        icon: ConnectIcon,
        title: "All-in-One Platform",
        description: "Orders, customers, conversations, and analytics in one place.",
      },
      {
        icon: CustomerIcon,
        title: "No Lock-in",
        description: "Cancel or switch plans anytime from your settings.",
      },
    ],
    illustration: CubeIcon,
  },
  "account-type": {
    features: [
      {
        icon: ConnectIcon,
        title: "Unified Operations",
        description: "Track orders, inventory, and fulfillment from all your connected stores in one place.",
      },
      {
        icon: TeamIcon,
        title: "For Teams & Businesses",
        description: "Built for growing teams that need shared customer data, collaboration, and permissions.",
      },
      {
        icon: ScaleIcon,
        title: "Multi-Channel Management",
        description: "Connect stores, sync inventory, and manage orders centrally.",
      },
    ],
    illustration: CubeIcon,
  },
  "create-organization": {
    features: [
      {
        icon: ConnectIcon,
        title: "Unified Operations",
        description: "Track orders, inventory, and fulfillment from all your connected stores in one place.",
      },
      {
        icon: TeamIcon,
        title: "For Teams & Businesses",
        description: "Built for growing teams that need shared customer data, collaboration, and permissions.",
      },
      {
        icon: ScaleIcon,
        title: "Multi-Channel Management",
        description: "Connect stores, sync inventory, and manage orders centrally.",
      },
    ],
    illustration: OrganizationStepIcon,
  },
  "invite-team": {
    features: [
      {
        icon: TeamIcon,
        title: "Real-Time Collaboration",
        description: "Work together on customer conversations and orders seamlessly.",
      },
      {
        icon: CustomerIcon,
        title: "Role-Based Access",
        description: "Assign Admins, Managers, Agents, or Viewers with fine-grained permissions.",
      },
      {
        icon: ConnectIcon,
        title: "Grow Your Team",
        description: "Add more members anytime from your organization settings.",
      },
    ],
    illustration: InviteIcon,
  },
} as const;

type StepKey = keyof typeof STEP_CONFIG;

/**
 * Shared layout for the onboarding flow (choose plan, account type, create org, invite team).
 * The left sidebar features and illustration update based on the current step.
 */
export default function OnboardingLayout() {
  const location = useLocation();
  const segment = location.pathname.split("/").pop() as StepKey;
  const currentStep = STEP_CONFIG[segment] ?? STEP_CONFIG["choose-plan"];
  const Illustration = currentStep.illustration;

  return (
    // <OnboardingGuard>
    <div className="flex min-h-svh flex-col bg-[#f1f7fa]">
      <main className="flex flex-row h-full">
        <div className="w-[25%] h-full bg-[linear-gradient(180deg,_#CEF17B_0%,_#F1F7FA_93%,_#F1F7FA_100%)]">
          <div className="flex flex-col items-center justify-between min-h-svh p-10">
            <span className="font-baumans text-[38px] font-bold text-[#084734]">collabo</span>
            <div className="flex flex-col items-center justify-center">
              <div key={segment} className="flex flex-col items-start justify-center gap-6 w-full h-full">
                {currentStep.features.map((feature) => (
                  <div key={feature.title} className="flex flex-row items-start justify-center gap-4">
                    <div className="size-6 rounded-[12%] bg-[#DDF3E8] flex items-center justify-center p-5">
                      <div><feature.icon /></div>
                    </div>
                    <div className="flex flex-col items-start justify-center gap-1">
                      <span className="text-[16px] font-bold text-[#000000]">{feature.title}</span>
                      <p className="text-[12px] text-gray-500">{feature.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <Illustration />
          </div>
        </div>

        <div className="w-[75%] h-full">
          <Outlet />
        </div>
      </main>

      <footer className="py-5 text-center text-xs text-gray-400">
        &copy; {new Date().getFullYear()} Collabo Digital Network. All rights reserved.
      </footer>
    </div>
    // </OnboardingGuard>
  );
}
