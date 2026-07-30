import { describe, test, expect } from "vitest";
import {
  deriveTagName,
  tagToSelector,
  extractQmlComponentAs,
  extractClassName,
  extractInputNames,
  extractOutputNames,
  extractModelNames,
  extractQPropertyNamesFromSource,
  extractChildControllerInfo,
  buildChildRegistry,
  type ChildControllerInfo,
} from "@mocha/compiler-web";

const sampleChildSource = `
import { QObject, input, output, model, QProperty } from "@mocha/core";
import { QMLComponent, qml } from "@mocha/core/qml";

@QMLComponent({
  qml: qml\`
    import QtQuick
    Item {
      Text { text: "child" }
    }
  \`,
  as: "Child",
})
class ChildController extends QObject {
  name = input<string>("default");
  age = input(0);
  value = model<number>(0);
  clicked = output<{ id: string }>();
  saved = output();

  @qproperty counter = new QProperty(0);

  handleClick() {
    this.clicked.emit({ id: "x" });
  }
}
`;

describe("deriveTagName", () => {
  test("strips Controller suffix", () => {
    expect(deriveTagName("ChildController")).toBe("Child");
  });
  test("preserves names without suffix", () => {
    expect(deriveTagName("Child")).toBe("Child");
    expect(deriveTagName("AppRoot")).toBe("AppRoot");
  });
});

describe("tagToSelector", () => {
  test("PascalCase to kebab-case with prefix", () => {
    expect(tagToSelector("Child")).toBe("app-child");
    expect(tagToSelector("MyCard")).toBe("app-my-card");
    expect(tagToSelector("FooBarBaz")).toBe("app-foo-bar-baz");
  });
  test("custom prefix", () => {
    expect(tagToSelector("Child", "mocha")).toBe("mocha-child");
  });
});

describe("extractQmlComponentAs", () => {
  test("extracts explicit `as` value", () => {
    expect(extractQmlComponentAs(sampleChildSource)).toBe("Child");
  });
  test("returns undefined when no `as`", () => {
    const src = `@QMLComponent({ qml: qml\`...\` }) class Foo {}`;
    expect(extractQmlComponentAs(src)).toBeUndefined();
  });
  test("returns null when no @QMLComponent", () => {
    expect(extractQmlComponentAs("class Foo {}")).toBeNull();
  });
});

describe("extractClassName", () => {
  test("finds the class extending QObject", () => {
    expect(extractClassName(sampleChildSource)).toBe("ChildController");
  });
  test("returns null when no QObject subclass", () => {
    expect(extractClassName("const x = 1;")).toBeNull();
  });
});

describe("extractInputNames", () => {
  test("finds all input() declarations", () => {
    expect(extractInputNames(sampleChildSource).sort()).toEqual(
      ["age", "name"]
    );
  });
  test("handles generic input<X>() syntax", () => {
    const src = `class X {
      a = input<string>();
      b = input<number>("default");
      c = input();
    }`;
    expect(extractInputNames(src).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("extractOutputNames", () => {
  test("finds all output() declarations", () => {
    expect(extractOutputNames(sampleChildSource).sort()).toEqual(
      ["clicked", "saved"]
    );
  });
});

describe("extractModelNames", () => {
  test("finds all model() declarations", () => {
    expect(extractModelNames(sampleChildSource)).toEqual(["value"]);
  });
});

describe("extractQPropertyNamesFromSource", () => {
  test("finds all @qproperty fields", () => {
    expect(extractQPropertyNamesFromSource(sampleChildSource)).toEqual([
      "counter",
    ]);
  });
});

describe("extractChildControllerInfo", () => {
  test("returns full info for valid source", () => {
    const info = extractChildControllerInfo(sampleChildSource, "/tmp/Child.qml.ts");
    expect(info).toEqual<ChildControllerInfo>({
      className: "ChildController",
      tag: "Child",
      sourcePath: "/tmp/Child.qml.ts",
      inputNames: ["age", "name"],
      outputNames: ["clicked", "saved"],
      modelNames: ["value"],
      qpropertyNames: ["counter"],
    });
  });
  test("returns null for non-component source", () => {
    expect(extractChildControllerInfo("class Foo {}")).toBeNull();
  });
  test("auto-derives tag when no `as`", () => {
    const src = `
      @QMLComponent({ qml: qml\`...\` })
      class MyWidgetController extends QObject {}
    `;
    const info = extractChildControllerInfo(src);
    expect(info?.tag).toBe("MyWidget");
    expect(info?.className).toBe("MyWidgetController");
  });
});

describe("buildChildRegistry", () => {
  test("builds a tag → info map from multiple sources", () => {
    const childA = extractChildControllerInfo(sampleChildSource, "/tmp/Child.qml.ts")!;
    const cardSource = `
      @QMLComponent({ qml: qml\`...\` })
      class CardController extends QObject {
        title = input("Untitled");
      }
    `;
    const childB = extractChildControllerInfo(cardSource, "/tmp/Card.qml.ts")!;
    const registry = buildChildRegistry([
      { source: sampleChildSource, path: "/tmp/Child.qml.ts" },
      { source: cardSource, path: "/tmp/Card.qml.ts" },
    ]);
    expect(registry.size).toBe(2);
    expect(registry.get("Child")).toEqual(childA);
    expect(registry.get("Card")).toEqual(childB);
  });
});
