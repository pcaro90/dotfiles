return {
	"akinsho/bufferline.nvim",
	version = "*",
	event = "VeryLazy",
	dependencies = "nvim-tree/nvim-web-devicons",
	opts = {
		options = {
			show_close_icon = false,
			show_buffer_close_icons = false,
			show_tab_indicators = true,
			indicator = { style = "underline" },
			diagnostics = "nvim_lsp",
			diagnostics_indicator = function(count, level, diagnostics_dict, context)
				local icon = level:match("error") and " " or " "
				return " " .. icon .. count
			end,
		},
	},
	keys = {
		{ "<leader>bp", "<cmd>BufferLinePick<CR>", desc = "Buffer: Pick a buffer to open" },
		-- { "H", "<cmd>BufferLineCyclePrev<CR>", desc = "Buffer: Move to the previous buffer" },
		{ "<leader>bh", "<cmd>BufferLineCyclePrev<CR>", desc = "Buffer: Move to the previous buffer" },
		-- { "L", "<cmd>BufferLineCycleNext<CR>", desc = "Buffer: Move to the next buffer" },
		{ "<leader>bl", "<cmd>BufferLineCycleNext<CR>", desc = "Buffer: Move to the next buffer" },
	},
}
