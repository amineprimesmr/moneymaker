//
//  ScreenshotTests.swift
//  Captures App Store prises sur un vrai iPhone : connexion par jeton d'environnement,
//  navigation par liens profonds, une capture par écran (pièces jointes du .xcresult).
//

import XCTest

final class ScreenshotTests: XCTestCase {
    func testAppStoreScreenshots() throws {
        let token = ProcessInfo.processInfo.environment["MM_TOKEN"] ?? ""
        try XCTSkipIf(!token.hasPrefix("mm_pat_"), "MM_TOKEN manquant")
        let app = XCUIApplication()
        app.launchEnvironment["MM_UI_TEST_TOKEN"] = token
        app.launch()
        sleep(9)                      // animation d'entrée + chargement des données
        shot(app, "1-accueil")
        for (name, link) in [("2-ventes", "moneymaker://feed"), ("3-planete", "moneymaker://globe"), ("4-pilotage", "moneymaker://plan")] {
            app.open(URL(string: link)!)
            sleep(5)
            shot(app, name)
        }
        app.open(URL(string: "moneymaker://today")!)
        sleep(2)
        app.swipeUp(); app.swipeUp()
        sleep(2)
        shot(app, "5-accueil-suite")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
