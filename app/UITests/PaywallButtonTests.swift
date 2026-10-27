//
//  PaywallButtonTests.swift
//  Réglages → « Business illimités » doit ouvrir le paywall (refus App Review 2.1(a), version 1.1).
//  Lancé seulement avec MM_PAYWALL_TEST=1 : il peut basculer le mode testeur du compte connecté.
//

import XCTest

final class PaywallButtonTests: XCTestCase {
    func testBusinessIllimitesOpensPaywall() throws {
        try XCTSkipIf(ProcessInfo.processInfo.environment["MM_PAYWALL_TEST"] == nil, "MM_PAYWALL_TEST absent")
        let app = XCUIApplication()
        app.launchEnvironment["MM_UI_TEST_TOKEN"] = ProcessInfo.processInfo.environment["MM_TOKEN"] ?? "mm_demo"
        app.launch()
        sleep(8)
        app.open(URL(string: "moneymaker://settings")!)
        sleep(3)

        // Compte testeur en Pro : passage en gratuit le temps du test, pour faire apparaître le bouton.
        let proToggle = app.switches["Compte en Pro"]
        let rowQuery = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Business illimités'"))
        var switchedToFree = false
        for _ in 0..<8 where !rowQuery.firstMatch.exists && !proToggle.exists { app.swipeUp() }
        if proToggle.exists { proToggle.switches.firstMatch.tap(); switchedToFree = true; sleep(3) }

        let row = rowQuery.firstMatch
        for _ in 0..<8 where row.exists && !row.isHittable { app.swipeDown() }
        for _ in 0..<8 where row.exists && !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "bouton Business illimités introuvable")
        shot("1-reglages")
        row.tap()
        let paywall = app.buttons["paywall.close"]
        XCTAssertTrue(paywall.waitForExistence(timeout: 6) && paywall.isHittable, "le paywall ne s'est pas ouvert")
        sleep(1)
        shot("2-paywall")


        if switchedToFree {
            sleep(2)
            let freeToggle = app.switches["Compte en gratuit"]
            for _ in 0..<8 where !freeToggle.exists { app.swipeDown() }
            if freeToggle.exists { freeToggle.switches.firstMatch.tap(); sleep(2) }
            XCTAssertTrue(app.switches["Compte en Pro"].waitForExistence(timeout: 5), "compte non remis en Pro")
        }
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
