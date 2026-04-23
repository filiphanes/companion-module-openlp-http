const { InstanceBase, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const WebSocket = require('ws')

function rgb(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

class ModuleInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

async init(config) {
		this.config = config

    this.choices_mode = [
      { label: 'Show', id: 'show' },
      { label: 'Blank', id: 'blank' },
      { label: 'Theme', id: 'theme' },
      { label: 'Desktop', id: 'desktop' },
    ]

    this.choices_mode_with_toggle = [{ id: 'toggle', label: 'Toggle Blank/Show' }, ...this.choices_mode]

    this.choices_progress = [
      {
        id: 'previous',
        label: 'Previous slide',
        button_label: 'Prev\\nslide',
        path: 'controller',
        action: 'previous',
      },
      {
        id: 'next',
        label: 'Next slide',
        button_label: 'Next\\nslide',
        path: 'controller',
        action: 'next',
      },
      {
        id: 'prevSi',
        label: 'Previous service item',
        button_label: 'Prev\\nservice item',
        path: 'service',
        action: 'previous',
      },
      {
        id: 'nextSi',
        label: 'Next service item',
        button_label: 'Next\\nservice item',
        path: 'service',
        action: 'next',
      },
    ]

    this.updateStatus(InstanceStatus.Connecting, 'Initializing')
    this.initVariables()
    this.initActions()
    this.initPresets()
    this.initFeedbacks()

    this.service_increment = -1 // incremental version counter
    this.current_si = -1 // counted from 0
    this.current_slide = -1 // counted from 0
    this.current_si_uid = 'asdf' // current service item
    this.v3_service_list_data = [] // for switching SI in v3
    this.mode = -1

    if (this.config.ip) {
      if (this.config.version == 'v3') {
        this.config.port = 4316
        this.initV3()
      } else {
        this.initV2()
      }
    } else {
      this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
    }

    this.auth_error = false
    this.polling = true
  }

  // Return config fields for web config
  getConfigFields() {
    return [
      {
        type: 'dropdown',
        label: 'OpenLP version',
        id: 'version',
        default: 'v2',
        width: 5,
        choices: [
          { id: 'v3', label: '3.0' },
          { id: 'v2', label: '2.4' },
        ],
      },
      {
        type: 'textinput',
        id: 'ip',
        label: 'Target IP',
        width: 8,
        required: true,
        default: '127.0.0.1',
        regex: this.REGEX_IP,
      },
      {
        type: 'number',
        id: 'port',
        label: 'Target Port',
        tooltip: 'The host of the OpenLP application',
        width: 3,
        default: 4316,
        regex: this.REGEX_PORT,
        isVisible: (configValues) => configValues.version === 'v2',
      },
      {
        type: 'textinput',
        id: 'username',
        label: 'Username',
        tooltip: 'The username in case login is required',
        width: 5,
      },
      {
        type: 'textinput',
        id: 'password',
        label: 'Password',
        tooltip: 'The password in case login is required',
        width: 5,
      },
      {
        type: 'number',
        id: 'serviceItemLimit',
        label: 'Service items max count',
        default: 7,
        tooltip: 'Number of service items fetched into variables',
        width: 4,
        min: 0,
        max: 50,
      },
      {
        type: 'number',
        id: 'slideItemLimit',
        label: 'Slides max count',
        default: 12,
        tooltip: 'Number of slides fetched into variables',
        width: 4,
        min: 0,
        max: 50,
      },
      {
        type: 'textinput',
        id: 'serviceItemEmptyText',
        label: 'Empty string',
        default: '-',
        tooltip: 'What to display as empty value',
        width: 4,
      },
    ]
  }

  async initV3() {
    try {
      const res = await fetch('http://' + this.config.ip + ':' + this.config.port + '/api/v2/core/system', {
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await res.json()
      this.initWebSocket(data.websocket_port)
      if (data.login_required) {
        if (!this.config.username || !this.config.password) {
          this.log('error', 'Please update user/password in module config, remote management requires authentication')
        } else {
          this.loginV3()
        }
      }
    } catch (err) {
      this.updateStatus(InstanceStatus.ConnectionFailure, `${err.message}`)
      this.log('error', 'HTTP GET Request failed (' + err.message + ')')
    }
  }

  initWebSocket(websocket_port) {
    this.updateStatus(InstanceStatus.Connecting)
    if (!websocket_port) {
      this.updateStatus(InstanceStatus.BadConfig, 'Missing WebSocket port')
      return
    }

    if (this.ws !== undefined) {
      this.ws.close(1000)
      delete this.ws
    }
    this.ws = new WebSocket(`ws://${this.config.ip}:${websocket_port}`)

    this.ws.on('open', () => {
      this.log('debug', 'Connection opened via WS')
      this.updateStatus(InstanceStatus.Ok)
    })
    this.ws.on('close', (code) => {
      this.log('debug', `Connection closed with code ${code}`)
      this.updateStatus(InstanceStatus.ConnectionFailure, `Connection closed with code ${code}`)
    })

    this.ws.on('message', this.interpretPollData)

    this.ws.on('error', (data) => {
      this.log('error', `WebSocket error: ${data}`)
    })
  }

async loginV3() {
    try {
      const res = await fetch(`http://${this.config.ip}:${this.config.port}/api/v2/core/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      })
      const result = await res.json()
      if (!res.ok) {
        this.log('error', `Login failed (${res.status})`)
        this.updateStatus(InstanceStatus.AuthenticationFailure, `Login failed (${res.status})`)
      } else {
        this.updateStatus(InstanceStatus.Ok)
        this.token = result.token
      }
    } catch (err) {
      this.log('error', `Login failed (${err.message})`)
      this.updateStatus(InstanceStatus.AuthenticationFailure, `Login failed (${err.message})`)
    }
  }

	// When module gets deleted
	async destroy() {
    clearInterval(this.pollingInterval)

    if (this.ws !== undefined) {
      this.ws.close(1000)
      delete this.ws
    }

    this.updateStatus(InstanceStatus.Disconnected)
  }

  throw401Warning() {
    this.log('error', 'Remote management requires authentication')
    this.updateStatus(InstanceStatus.UnknownWarning, 'Limited connection, only variables will work. Login is required.')
  }

  initV2() {
    this.pollingInterval = setInterval(() => {
      this.poll()
    }, 500)
  }

  initVariables() {
    const serviceItemLimit = this.config.serviceItemLimit ?? 7
    const slideItemLimit = this.config.slideItemLimit ?? 12

    const vars = [
      {
        variableId: 'display_mode',
        name: 'Current display mode',
      },
      {
        variableId: 'slide',
        name: 'Current slide number',
      },
      {
        variableId: 'slide_current',
        name: 'Current slide text',
      },
      {
        variableId: 'slide_next',
        name: 'Next slide text',
      },
      {
        variableId: 'slide_tag',
        name: 'Current slide tag',
      },
      {
        variableId: 'service_item',
        name: 'Current service item',
      },
      {
        variableId: 'service_cnt',
        name: 'Number of service items',
      },
      {
        variableId: 'slides_count',
        name: 'Number of slides in current service item',
      },
      {
        variableId: 'screen_hidden',
        name: 'Screen is hidden/blank',
      },
    ]

    for (let i = 1; i <= serviceItemLimit; i++) {
      vars.push({ variableId: `si_${i}`, name: `${i}. service item` })
    }

    for (let i = 1; i <= slideItemLimit; i++) {
      vars.push({ variableId: `slide_${i}`, name: `${i}. slide` })
      vars.push({ variableId: `slide_tag_${i}`, name: `${i}. slide tag` })
    }

    this.setVariableDefinitions(vars)
  }

  initPresets() {
    let presets = this.choices_progress.map((a) => {
      return {
        category: 'Service items & Slides',
        label: a.label,
        bank: {
          style: 'text',
          text: a.button_label,
          size: 18,
          color: rgb(255, 255, 255),
          bgcolor: rgb(0, 0, 0),
        },
        actions: [
          {
            action: a.id,
          },
        ],
      }
    })

    Array.from({ length: 3 }, (x, i) => i).forEach((i) => {
      i++
      presets.push({
        category: 'Service items & Slides',
        label: i + ' $(openlp:si_' + i + ')',
        bank: {
          style: 'text',
          size: '14',
          text: i + ' $(openlp:si_' + i + ')',
          color: rgb(255, 255, 255),
          bgcolor: rgb(0, 0, 0),
        },
        actions: [
          {
            action: 'gotoSi',
            options: { si: i },
          },
        ],
        feedbacks: [
          {
            type: 'fbk_si',
            options: {
              si: i,
            },
            style: {
              bgcolor: rgb(255, 0, 0),
              color: rgb(255, 255, 255),
            },
          },
        ],
      })
    })
    Array.from({ length: 3 }, (x, i) => i).forEach((i) => {
      i++
      presets.push({
        category: 'Service items & Slides',
        label: 'Slide $(openlp:slide_tag_' + i + ')',
        bank: {
          style: 'text',
          text: 'Slide $(openlp:slide_tag_' + i + ')',
          color: rgb(255, 255, 255),
          bgcolor: rgb(0, 0, 0),
        },
        actions: [
          {
            action: 'gotoSlide',
            options: { slide: i },
          },
        ],
        feedbacks: [
          {
            type: 'fbk_slide',
            options: {
              slide: i,
            },
            style: {
              bgcolor: rgb(255, 0, 0),
              color: rgb(255, 255, 255),
            },
          },
        ],
      })
    })

    this.choices_mode.forEach((mode) => {
      presets.push({
        category: 'Display mode',
        label: mode.label,
        bank: {
          style: 'text',
          size: 18,
          text: mode.label,
          color: rgb(255, 255, 255),
          bgcolor: rgb(0, 51, 0),
        },
        actions: [
          {
            action: 'mode',
            options: {
              mode: mode.id,
            },
          },
        ],
        feedbacks: [
          {
            type: 'mode',
            options: {
              mode: mode.id,
            },
            style: {
              color: rgb(255, 255, 255),
              bgcolor: rgb(255, 0, 0),
            },
          },
        ],
      })
    })

    presets.push({
      category: 'Display mode',
      label: 'Toggle show/blank',
      bank: {
        style: 'text',
        text: 'Toggle $(openlp:display_mode)',
        color: rgb(255, 255, 255),
        bgcolor: rgb(0, 0, 0),
      },
      actions: [
        {
          action: 'mode',
          options: { mode: 'toggle' },
        },
      ],
      feedbacks: [
        {
          type: 'mode',
          options: {
            mode: 'show',
          },
          style: {
            color: rgb(255, 0, 0),
          },
        },
        {
          type: 'mode',
          options: {
            mode: 'blank',
          },
          style: {
            color: rgb(125, 125, 125),
          },
        },
      ],
    })

    this.setPresetDefinitions(presets)
  }

  static GetUpgradeScripts() {
    return [
      UpgradeScripts.updates013,
      UpgradeScripts.updates016,
    ]
  }

  initFeedbacks() {
    const feedbacks = {
      mode: {
        type: 'boolean',
        label: 'Display mode',
        description: 'If the display in defined mode, change style of the bank',
        style: {
          color: rgb(255, 255, 255),
          bgcolor: rgb(0, 0, 255),
        },
        options: [
          {
            type: 'dropdown',
            label: 'Mode',
            id: 'mode',
            choices: this.choices_mode,
            default: 'show',
          },
        ],
        callback: (feedback) => {
          return this.display_mode == feedback.options.mode
        },
      },
      fbk_slide: {
        type: 'boolean',
        label: 'Service item on specified slide',
        description: 'If specific slide is active, change style of the bank',
        style: {
          color: rgb(255, 255, 255),
          bgcolor: rgb(255, 0, 0),
        },
        options: [
          {
            type: 'number',
            label: 'Slide',
            id: 'slide',
            default: 1,
            min: 1,
          },
        ],
        callback: (feedback) => {
          return this.current_slide + 1 == feedback.options.slide
        },
      },
      fbk_si: {
        type: 'boolean',
        label: 'Service item active',
        description: 'If specific service item is active, change style of the bank',
        style: {
          color: rgb(255, 255, 255),
          bgcolor: rgb(255, 0, 0),
        },
        options: [
          {
            type: 'number',
            label: 'Service item',
            id: 'si',
            default: 1,
            min: 1,
          },
        ],
        callback: (feedback) => {
          return this.current_si + 1 == feedback.options.si
        },
      },
    }

    this.setFeedbackDefinitions(feedbacks)
  }

  initActions() {
    const action = (this.config.version == 'v3')
      ? this.actionV3
      : this.actionV2;

    const actions = {
      next: {
        name: 'Next Slide',
        options: [],
        callback: action,
      },
      previous: {
        name: 'Previous Slide',
        options: [],
        callback: action,
      },
      nextSi: {
        name: 'Next Service item',
        options: [],
        callback: action,
      },
      prevSi: {
        name: 'Prev Service item',
        options: [],
        callback: action,
      },
      mode: {
        name: 'Display mode',
        options: [
          {
            type: 'dropdown',
            label: 'Mode',
            id: 'mode',
            default: '0',
            choices: this.choices_mode_with_toggle,
            minChoicesForSearch: 0,
          },
        ],
        callback: action,
      },
      gotoSi: {
        name: 'Specific Service item',
        options: [
          {
            type: 'number',
            label: 'Service item',
            id: 'si',
            min: 1,
            default: 1,
          },
        ],
        callback: action,
      },
      gotoSlide: {
        name: 'Specific Slide (in current Service item)',
        options: [
          {
            type: 'number',
            label: 'Slide',
            id: 'slide',
            min: 1,
            default: 1,
          },
        ],
        callback: action,
      },
    }

    if (this.config.version == 'v2') {
      actions.refreshSiList = {
        name: 'Refresh Service items list',
        options: [],
        callback: action,
      }
    }

    this.setActionDefinitions(actions)
  }

  async actionV2(action) {
    let path = ''
    switch (action.actionId) {
      case 'gotoSi':
        path = 'service/set?data=' + JSON.stringify({ request: { id: Number(action.options.si - 1) } })
        break
      case 'refreshSiList':
        this.fetchServiceListV2()
        return
      case 'mode':
        let path = action.options.mode
        if (action.options.mode == 'toggle') {
          path = this.display_mode == 'blank' ? 'show' : 'blank'
        }
        path = 'display/' + path
        break
      case 'nextSi':
        path = 'service/next'
        break
      case 'prevSi':
        path = 'service/previous'
        break
      case 'next':
        path = 'controller/live/next'
        break
      case 'previous':
        path = 'controller/live/previous'
        break
      case 'gotoSlide':
        if (action.options.slide > this.slides_count) {
          return
        }
        path = 'controller/live/set?data=' + JSON.stringify({ request: { id: Number(action.options.slide - 1) } })
        break
    }
    const url = `http://${this.config.ip}:${this.config.port}/api/${path}`
    try {
      await fetch(url, { headers: this.headersV2() })
      this.auth_error = false
      this.updateStatus(InstanceStatus.Ok)
    } catch (err) {
      this.log('error', `HTTP Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, `HTTP Request returned ${err.message || 'unknown'}`)
      this.polling = false
    }
    this.polling = true
  }

  headersV3() {
    const headers = {}
    if (this.isSecure && this.token) {
      headers['Authorization'] = this.token
    }
    return headers
  }

  async actionV3(action) {
    if (this.isSecure && !this.token) {
      this.throw401Warning()
      return
    }

    let path = ''
    let param = {}

    switch (action.actionId) {
      case 'mode':
        path = 'core/display'
        param = {
          display: action.options.mode,
        }
        if (action.options.mode == 'toggle') {
          param.display = this.display_mode == 'blank' ? 'show' : 'blank'
        }
        break
      case 'nextSi':
        path = 'service/progress'
        param = {
          action: 'next',
        }
        break
      case 'prevSi':
        path = 'service/progress'
        param = {
          action: 'previous',
        }
        break
      case 'next':
        path = 'controller/progress'
        param = {
          action: 'next',
        }
        break
      case 'previous':
        path = 'controller/progress'
        param = {
          action: 'previous',
        }
        break
      case 'gotoSlide':
        if (action.options.slide > this.slides_count) {
          return
        }
        path = 'controller/show'
        param = { id: action.options.slide - 1 }
        break
      case 'gotoSi':
        path = 'service/show'
        param = { id: this.v3_service_list_data[action.options.si - 1].id }
        break
    }

    const url = `http://${this.config.ip}:${this.config.port}/api/v2/${path}`
    try {
      await fetch(url, {
        method: 'POST',
        headers: this.headersV3(),
        body: JSON.stringify(param),
      })
      this.auth_error = false
      this.updateStatus(InstanceStatus.Ok)
    } catch (err) {
      this.log('error', `HTTP Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, `HTTP Request returned ${err.message || 'unknown'}`)
      this.polling = false
    }
  }

headersV2() {
    const headers = {}
    if (this.config.username && this.config.password) {
      headers['Authorization'] =
        'Basic ' + Buffer.from(this.config.username + ':' + this.config.password).toString('base64')
    }
    return headers
  }

  async configUpdated(config) {
    this.config = config
    clearInterval(this.pollingInterval)
    await this.init()
  }

  async poll() {
    if (!this.config.ip && !this.config.port) {
      return
    }

    if (!this.polling) {
      return
    }

    try {
      const res = await fetch(
        'http://' + this.config.ip + ':' + this.config.port + '/api/poll',
        { headers: this.headersV2() }
      )
      const data = await res.json()
      this.interpretPollData(data.results)
    } catch (err) {
      this.log('error', `HTTP GET Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, err.message)
      this.polling = false
    }
  }

  interpretPollData(data) {
    if (this.config.version == 'v3') {
      let msgValue = null
      try {
        msgValue = JSON.parse(data)
      } catch (e) {
        msgValue = data
      }
      data = msgValue.results
    }
    this.isSecure = data.isSecure
    //console.log(data)
    let chkFbkSlide = false
    if (data.slide != this.current_slide) {
      chkFbkSlide = true
    }

    if (data.service > this.service_increment || data.item != this.current_si_uid) {
      chkFbkSlide = true
      this.fetchCurrentServiceList()
    }

    // for proper feedback
    this.current_slide = data.slide
    this.service_increment = data.service
    this.current_si_uid = data.item
    this.setVariableValues({ slide: data.slide + 1 })

    if (chkFbkSlide) {
      this.checkFeedbacks('fbk_slide')
    }

    let mode = 'Show'
    let screenHidden = false
    if (data.blank) {
      mode = 'Blank'
      screenHidden = true
    } else if (data.display) {
      mode = 'Desktop'
    } else if (data.theme) {
      mode = 'Theme'
    }
    this.display_mode = mode.toLowerCase()
    this.setVariableValues({ display_mode: mode, screen_hidden: screenHidden })
    this.checkFeedbacks('mode')
  }

  fetchCurrentServiceList() {
    if (this.config.version == 'v3') {
      this.fetchServiceListV3()
    } else {
      this.fetchServiceListV2()
    }
  }

  async fetchServiceListV2() {
    try {
      const res = await fetch(
        'http://' + this.config.ip + ':' + this.config.port + '/api/service/list',
        { headers: this.headersV2() }
      )
      const data = await res.json()
      this.interpretServiceListData(data.results.items)
    } catch (err) {
      this.log('error', `HTTP GET Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, err.message)
      this.polling = false
    }
  }

  async fetchServiceListV3() {
    try {
      const res = await fetch(
        'http://' + this.config.ip + ':' + this.config.port + '/api/v2/service/items',
        { headers: this.headersV3() }
      )
      const data = await res.json()
      this.v3_service_list_data = data
      this.interpretServiceListData(data)
    } catch (err) {
      this.log('error', `HTTP GET Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, err.message)
      this.polling = false
    }
  }

  interpretServiceListData(items) {
    if (!Array.isArray(items)) return
    this.setVariableValues({ service_cnt: items.length })
    items.forEach((si, i) => {
      this.setVariableValues({ [`si_${i + 1}`]: si.title })
      //this.setVariable(`si_${i + 1}_short`, si.title.substr(0, 15))
      //this.setVariable(`si_${i + 1}_type`, si.plugin)
      if (si.selected) {
        this.current_si = i
        this.setVariableValues({ service_item: si.title })
        //this.setVariable(`current_si_short`, si.title.substr(0, 15))
      }
    })
    for (let i = items.length + 1; i <= this.config.serviceItemLimit; i++) {
      this.setVariableValues({ [`si_${i}`]: this.config.serviceItemEmptyText })
      //this.setVariable(`si_${i}_short`, this.config.serviceItemEmptyText)
      //this.setVariable(`si_${i}_type`, this.config.serviceItemEmptyText)
    }
    this.checkFeedbacks('fbk_si')
    this.loadSlides()
  }

  loadSlides() {
    this.slides_count = 0
    if (this.config.version == 'v3') {
      this.loadSlidesV3()
    } else {
      this.loadSlidesV2()
    }
  }
  async loadSlidesV2() {
    try {
      const res = await fetch(
        'http://' + this.config.ip + ':' + this.config.port + '/api/controller/live/text',
        { headers: this.headersV2() }
      )
      const data = await res.json()
      this.interpretSlideListData(data.results.slides)
    } catch (err) {
      this.log('error', `HTTP GET Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, err.message)
      this.polling = false
    }
  }

  async loadSlidesV3() {
    try {
      const res = await fetch(
        'http://' + this.config.ip + ':' + this.config.port + '/api/v2/controller/live-items',
        { headers: this.headersV3() }
      )
      const data = await res.json()
      this.interpretSlideListData(data.slides)
    } catch (err) {
      this.log('error', `HTTP GET Request failed (${err.message || 'unknown'})`)
      this.updateStatus(InstanceStatus.UnknownError, err.message)
      this.polling = false
    }
  }

  interpretSlideListData(slides) {
    if (!Array.isArray(slides)) return
    const updates = { slides_count: slides.length }
    this.slides_count = slides.length
    slides.forEach((sl, i) => {
      updates[`slide_tag_${i + 1}`] = sl.tag
      updates[`slide_${i + 1}`] = sl.text || ''
      if (sl.selected) {
        this.current_slide = i
        updates.slide_tag = sl.tag
        updates.slide_current = sl.text ? sl.text : ''
        // Set next slide text
        const nextSlide = slides[i + 1]
        updates.slide_next = nextSlide ? (nextSlide.text || '').substr(0, 19) : ''
      }
    })
    for (let i = slides.length + 1; i <= this.config.slideItemLimit; i++) {
      updates[`slide_tag_${i}`] = this.config.serviceItemEmptyText
      updates[`slide_${i}`] = this.config.serviceItemEmptyText
    }
    this.setVariableValues(updates)
    this.checkFeedbacks('fbk_slide')
  }

}

runEntrypoint(ModuleInstance, UpgradeScripts)

