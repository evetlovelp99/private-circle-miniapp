Component({
  options: { styleIsolation: "shared" },
  properties: {
    identity: { type: String, value: "" },
    size: { type: Number, value: 80 }
  },
  data: { colorName: "blue" },
  observers: {
    identity(value) {
      let hash = 0;
      for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
      this.setData({ colorName: ["blue", "yellow", "green-soft", "pink", "orange"][hash % 5] });
    }
  }
});
