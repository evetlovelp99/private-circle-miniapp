Component({
  options: { styleIsolation: "shared" },
  data: { selected: "", hidden: false },
  lifetimes: { attached() { this.syncSelection(); } },
  pageLifetimes: { show() { this.syncSelection(); } },
  methods: {
    syncSelection() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      this.setData({ selected: page ? "/" + page.route : "" });
    },
    switchTab(e) {
      const url = e.currentTarget.dataset.url;
      wx.switchTab({ url, success: () => this.syncSelection() });
    }
  }
});
