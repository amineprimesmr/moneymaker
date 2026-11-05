//
//  OnboardingTests.swift
//  Onboarding, puis message pour l'agent, puis connexion (à lancer déconnecté).
//

import XCTest

final class OnboardingTests: XCTestCase {
    func testWelcomeThenOnboarding() {
        let app = XCUIApplication()
        app.launchEnvironment["MM_UI_TEST_ONBOARDING"] = "1"
        app.launchArguments += ["-AppleLanguages", "(fr)", "-AppleLocale", "fr_FR"]
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
        app.buttons["J'ai déjà un compte"].tap()
        XCTAssertTrue(app.staticTexts["Connecte-toi à ton compte"].waitForExistence(timeout: 5))
        shot(app, "7-connexion")
        // Les boutons de connexion doivent réagir, sur iPad aussi (rejet 2.1(a) du 5 nov. 2026).
        let email = app.buttons["Continuer avec un e-mail"]
        if email.waitForExistence(timeout: 3) {
            XCTAssertTrue(email.isHittable)
            email.tap()
            XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5), "le formulaire e-mail ne s'ouvre pas")
            shot(app, "8-email")
            app.buttons.element(boundBy: 0).tap()
            sleep(1)
        }
        app.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Copier le message"].waitForExistence(timeout: 5))
        let demo = app.buttons["Essayer la démo"]
        XCTAssertTrue(demo.waitForExistence(timeout: 5))
        XCTAssertTrue(demo.isHittable)
        demo.tap()
        XCTAssertFalse(app.buttons["Copier le message"].waitForExistence(timeout: 12) && app.buttons["Copier le message"].isHittable, "la démo ne s'ouvre pas")
        sleep(6); shot(app, "9-demo")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
