// Single source of truth for what is live. Flip a flag and the page updates; no redesign.
// available:false => a "Sắp có" label/state is rendered where the item appears.
window.VNBOT_FEATURES={
  WEB_APP_URL:'https://app.vnbot.run',
  webAppLive:false,            // public WEB_APP_URL reachable? (app.vnbot.run has no DNS yet) false => contact is primary, web button inert
  releasesLive:false,          // installers published? false => download buttons show "Sắp có"
  showFree:true,               // hero "Miễn phí" wording + 0đ section + free nav/FAQ
  downloadBase:'https://vnbot.run/download/',
  CONTACT_URL:'https://aikingx.com',
  platforms:{                  // node/app per platform
    web:{name:'Web'},                    // availability derives from webAppLive (web client app.vnbot.run -> your node),
    mac:{name:'macOS',ext:'.dmg',icon:'',available:true},
    windows:{name:'Windows',ext:'.exe',icon:'',available:true},
    linux:{name:'Linux',ext:'.AppImage',icon:'linux.svg',available:true},
    android:{name:'Android',ext:'.apk',icon:'android.svg',available:true},
    ios:{name:'iOS',ext:'',icon:'',available:false}
  },
  features:{
    bots:{available:true},          // one job per bot, memory
    computer:{available:true},      // own browser/terminal/files
    schedule:{available:true},
    connectors:{available:true},    // apps, MCP, API
    voice:{available:true},
    groupChat:{available:true},
    ownNode:{available:true},       // runs on your machine
    remoteAccess:{available:false} // web/phone from anywhere via vnbot.run gateway (P2P, ADR 0001: Proposed, not built)
  }
};
window.VNBOT_FEATURES.platforms.web.available=window.VNBOT_FEATURES.webAppLive;
