//
//  OnboardingTests.swift
//  Onboarding, puis message pour l'agent, puis connexion (à lancer déconnecté).
//

import XCTest

final class OnboardingTests: XCTestCase {
    func testWelcomeThenOnboarding() {
        let app = XCUIApplication()
        app.launchEnvironment["MM_UI_TEST_ONBOARDING"] = "1"
        app.launch()
        sleep(3); shot(app, "0a-intro")
        sleep(4); shot(app, "0b-intro")
        XCTAssertTrue(app.buttons["Continuer"].waitForExistence(timeout: 30))   // après l'intro animée
        sleep(2)
        for i in 1...4 {
            shot(app, "\(i)-onboarding")
            app.buttons["Continuer"].tap()
            sleep(1)
        }
        shot(app, "5-onboarding")
        app.buttons["Commencer"].tap()

        XCTAssertTrue(app.buttons["Copier le message"].waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "6-agent")
        app.buttons["J'ai créé mon compte"].tap()
        XCTAssertTrue(app.staticTexts["Connecte-toi à ton compte"].waitForExistence(timeout: 5))
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
