import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: any) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { DynamicIslandHeader } from "@/components/mast/DynamicIslandHeader";
import { IDLE_DYNAMIC_ISLAND_EVENT } from "@/lib/dynamic-island";

describe("DynamicIslandHeader clickable reply notifications", () => {
  afterEach(() => {
    cleanup();
  });

  it("triggers onNotificationClick when clicking a reply notification and stops propagation on dismiss", () => {
    const onNotificationClick = vi.fn();
    const onDismissNotification = vi.fn();

    render(
      <DynamicIslandHeader
        event={IDLE_DYNAMIC_ISLAND_EVENT}
        user={{ fullName: "Alex", email: "alex@mast.io" }}
        unreadCount={1}
        notifications={[
          {
            id: "srv:notif-1",
            icon: "Instagram",
            title: "Luna Bakery replied on Instagram",
            body: "Can you send your pricing?",
            time: "Just now",
            unread: true,
            actionUrl: "/dashboard/leads/42?channel=instagram",
            source: "server",
          },
        ]}
        onNotificationClick={onNotificationClick}
        onDismissNotification={onDismissNotification}
      />,
    );

    // Open notifications drawer via the Dynamic Island center button
    const islandCenter = screen.getByTestId("dynamic-island-center");
    fireEvent.click(islandCenter);

    const item = screen.getByTestId("dynamic-island-notification-item");
    const dismissBtn = screen.getByLabelText("Dismiss notification");

    fireEvent.click(dismissBtn);
    expect(onDismissNotification).toHaveBeenCalledWith("srv:notif-1");
    expect(onNotificationClick).not.toHaveBeenCalled();

    fireEvent.click(item);
    expect(onNotificationClick).toHaveBeenCalledTimes(1);
    expect(onNotificationClick.mock.calls[0][0].actionUrl).toBe("/dashboard/leads/42?channel=instagram");
  });
});
