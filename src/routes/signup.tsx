import { createFileRoute } from "@tanstack/react-router";
import { AuthShell } from "./login";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Sign Up — Mast" },
      { name: "description", content: "Create your Mast account. 100 free credits, no credit card required." },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  return <AuthShell mode="signup" />;
}
