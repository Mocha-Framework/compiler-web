import { describe, test, expect } from "vitest";
import { compileQmlToAngular } from "@mocha/compiler-web";

function compile(qml: string) {
  return compileQmlToAngular(qml, {
    target: "web",
    selector: "app-test",
    className: "TestComponent",
    controllerSource: "class C {}",
    controllerName: "C",
    qpropertyNames: ["count"],
    methodNames: [],
  });
}

describe("qml-to-angular: RouterLink + string literal safety net", () => {
  test("RouterLink reads `to` and emits routerLink directive with child Text", () => {
    const { template } = compile(`
      VStack {
        RouterLink {
          to: "/about"
          Text {
            text: "About"
          }
        }
      }
    `);
    expect(template).toContain(`routerLink="/about"`);
    expect(template).toContain("routerLinkActive");
    expect(template).toMatch(/<a[^>]*>\s*<qml-text/);
    expect(template).toContain(`[text]="'About'"`);
  });

  test("RouterLink compact `text` becomes <span [innerText]=\"'...'\"> when no children", () => {
    const { template } = compile(`
      VStack {
        RouterLink {
          to: "/x"
          text: "Go"
        }
      }
    `);
    expect(template).toContain(`routerLink="/x"`);
    expect(template).toMatch(/<span \[innerText\]="'Go'"><\/span>/);
  });

  test("RouterLink accepts `path` as fallback after `to`", () => {
    const { template } = compile(`
      VStack {
        RouterLink {
          path: "/old"
        }
      }
    `);
    expect(template).toContain(`routerLink="/old"`);
  });

  test("Quoted string literal `text: \"About\"` is wrapped in quotes (not identifier ref)", () => {
    const { template } = compile(`
      VStack {
        Text {
          text: "About"
        }
      }
    `);
    expect(template).toContain(`[text]="'About'"`);
    expect(template).not.toContain(`[text]="About"`);
  });

  test("Path-like string literal `/users/:id` stays in routerLink attribute", () => {
    const { template } = compile(`
      VStack {
        RouterLink {
          to: "/users/:id"
        }
      }
    `);
    expect(template).toContain(`routerLink="/users/:id"`);
  });

  test("Numeric and boolean values still emit as bare JS expressions", () => {
    const { template } = compile(`
      VStack {
        Text {
          text: "x"
          fontPixelSize: 16
        }
      }
    `);
    expect(template).toContain(`[text]="'x'"`);
    expect(template).toContain(`[fontPixelSize]="16"`);
  });

  test("controller.X.value binding still becomes [prop]=\"X()\"", () => {
    const { template } = compile(`
      VStack {
        Text {
          text: controller.count.value
        }
      }
    `);
    expect(template).toContain(`[text]="count()"`);
    expect(template).not.toContain(`[text]="'count()'"`);
  });

  test("RouterLink is imported from @angular/router (not @angular/core)", () => {
    const { componentTs } = compile(`
      VStack {
        RouterLink {
          to: "/x"
        }
      }
    `);
    expect(componentTs).toMatch(/^import\s*{\s*RouterLink[^}]*}\s*from\s*'@angular\/router'/m);
    expect(componentTs).not.toMatch(/^import\s*{\s*[^}]*RouterLink[^}]*}\s*from\s*'@angular\/core'/m);
  });
});