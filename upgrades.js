module.exports = [
	// Upgrade from 0.1.3: Add version, serviceItemEmptyText, serviceItemLimit
	function (context, config) {
		const changes = {}
		if (!config.version) {
			config.version = 'v2'
			changes.version = 'v2'
		}
		if (!config.serviceItemEmptyText) {
			config.serviceItemEmptyText = '-'
			changes.serviceItemEmptyText = '-'
		}
		if (!config.serviceItemLimit) {
			config.serviceItemLimit = 7
			changes.serviceItemLimit = 7
		}
		return {
			config: changes,
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
	// Upgrade from 0.1.6: Migrate mode action options from numbers to strings
	function (context, config, actions, feedbacks) {
		const configChanges = {}
		const updatedActions = []
		const updatedFeedbacks = []

		if (!config.slideItemLimit) {
			config.slideItemLimit = 12
			configChanges.slideItemLimit = 12
		}

		if (actions) {
			for (const action of actions) {
				if (action.actionId === 'mode' && action.options) {
					let newMode = null
					if (action.options.mode == '0') {
						newMode = 'show'
					} else if (action.options.mode == '1') {
						newMode = 'blank'
					} else if (action.options.mode == '2') {
						newMode = 'theme'
					} else if (action.options.mode == '3') {
						newMode = 'desktop'
					} else if (action.options.mode == '4') {
						newMode = 'toggle'
					}

					if (newMode) {
						updatedActions.push({
							id: action.id,
							actionId: action.actionId,
							options: { ...action.options, mode: newMode },
						})
					}
				}
			}
		}

		return {
			config: configChanges,
			updatedActions,
			updatedFeedbacks,
		}
	},
]