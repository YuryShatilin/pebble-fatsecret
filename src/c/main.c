// Watch side: one page per meal from today's FatSecret diary, in the order lunch, snacks, dinner,
// breakfast. Up and Down scroll a page one line at a time; at the end of a page the next press
// turns to the neighbouring page. Arrows show that a page has more lines in that direction.
// Select refreshes. Each food item takes exactly one line.
// The phone fetches on launch, so the menu is always for the current day.
#include <pebble.h>

#define RESPONSE_TIMEOUT_MS 30000
#define TEXT_BUFFER_SIZE 720
#define LINE_BUFFER_SIZE 160
#define PADDING 6
#define HEADER_HEIGHT 40
#define STATUS_HEIGHT 24
#define ROW_HEIGHT 26
#define ARROW_HEIGHT 14
#define PAGE_COUNT 4

enum {
  ERROR_NONE = 0,
  ERROR_NETWORK = 1,
  ERROR_BAD_DATA = 3,
  ERROR_NO_PHONE = 4,
  ERROR_API = 5
};

typedef struct {
  const char *title;
  GColor header;
  GColor header_text;
  // Items separated by '\n', one per line.
  char text[TEXT_BUFFER_SIZE];
  // First visible line.
  int scroll;
} Page;

static Page s_pages[PAGE_COUNT];
static uint32_t s_message_keys[PAGE_COUNT];

static Window *s_window;
static Layer *s_page_layer;
static AppTimer *s_response_timer;

static int s_page;
static bool s_has_menu;
static bool s_refreshing;
static int s_error = ERROR_NONE;
static int s_api_error;
static char s_status_text[40];

static void format_status(void) {
  if (s_refreshing) {
    snprintf(s_status_text, sizeof(s_status_text), "Обновление...");
    return;
  }
  switch (s_error) {
    case ERROR_NETWORK: snprintf(s_status_text, sizeof(s_status_text), "Нет сети"); break;
    case ERROR_BAD_DATA: snprintf(s_status_text, sizeof(s_status_text), "Ошибка данных"); break;
    case ERROR_NO_PHONE: snprintf(s_status_text, sizeof(s_status_text), "Нет телефона"); break;
    case ERROR_API: snprintf(s_status_text, sizeof(s_status_text), "Ошибка FatSecret %d", s_api_error); break;
    default: s_status_text[0] = '\0'; break;
  }
}

static int count_lines(const char *text) {
  if (text[0] == '\0') {
    return 0;
  }
  int count = 1;
  for (const char *p = text; *p != '\0'; p++) {
    if (*p == '\n') {
      count++;
    }
  }
  return count;
}

// Copies line number `index` of text into buffer.
static void copy_line(const char *text, int index, char *buffer, size_t size) {
  const char *start = text;
  for (int i = 0; i < index; i++) {
    start = strchr(start, '\n') + 1;
  }
  const char *end = strchr(start, '\n');
  size_t length = end != NULL ? (size_t)(end - start) : strlen(start);
  if (length > size - 1) {
    length = size - 1;
  }
  memcpy(buffer, start, length);
  buffer[length] = '\0';
}

static void draw_text_line(GContext *ctx, const char *text, GFont font, int y, int width, int height,
                           GTextAlignment alignment) {
  // A box one row high keeps the text on a single line, cut with an ellipsis.
  graphics_draw_text(ctx, text, font, GRect(PADDING, y, width - 2 * PADDING, height),
                     GTextOverflowModeTrailingEllipsis, alignment, NULL);
}

static int page_lines(int page) {
  return s_has_menu ? count_lines(s_pages[page].text) : 0;
}

// The list sits between the header and a strip for the down arrow, above the status line.
static GRect list_area(void) {
  GRect bounds = layer_get_bounds(s_page_layer);
  format_status();
  int top = HEADER_HEIGHT + 4;
  int bottom = bounds.size.h - ARROW_HEIGHT - (s_status_text[0] != '\0' ? STATUS_HEIGHT : 0);
  return GRect(0, top, bounds.size.w, bottom - top);
}

static int max_scroll(int page) {
  int extra = page_lines(page) - list_area().size.h / ROW_HEIGHT;
  return extra > 0 ? extra : 0;
}

// The visible area shrinks while a status line is shown, so the scroll is kept within range.
static int clamped_scroll(int page) {
  int limit = max_scroll(page);
  return s_pages[page].scroll > limit ? limit : s_pages[page].scroll;
}

static void draw_arrow(GContext *ctx, GColor color, int center_x, int top, bool down) {
  int y_tip = down ? top + ARROW_HEIGHT - 3 : top + 3;
  int y_base = down ? top + 3 : top + ARROW_HEIGHT - 3;
  GPathInfo info = {
    .num_points = 3,
    .points = (GPoint[]){{center_x - 8, y_base}, {center_x + 8, y_base}, {center_x, y_tip}}
  };
  GPath *path = gpath_create(&info);
  graphics_context_set_fill_color(ctx, color);
  gpath_draw_filled(ctx, path);
  gpath_destroy(path);
}

static void draw_page(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  int width = bounds.size.w;
  Page *page = &s_pages[s_page];
  int scroll = clamped_scroll(s_page);

  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_fill_color(ctx, page->header);
  graphics_fill_rect(ctx, GRect(0, 0, width, HEADER_HEIGHT), 0, GCornerNone);
  graphics_context_set_text_color(ctx, page->header_text);
  draw_text_line(ctx, page->title, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD), 2, width,
                 HEADER_HEIGHT - 2, GTextAlignmentCenter);

  // Arrows mean more lines in that direction; without one the next press turns the page.
  GRect area = list_area();
  if (scroll > 0) {
    draw_arrow(ctx, page->header_text, width - PADDING - 10, (HEADER_HEIGHT - ARROW_HEIGHT) / 2, false);
  }
  if (scroll < max_scroll(s_page)) {
    draw_arrow(ctx, GColorBlack, width / 2, area.origin.y + area.size.h, true);
  }

  graphics_context_set_text_color(ctx, GColorBlack);
  if (s_status_text[0] != '\0') {
    draw_text_line(ctx, s_status_text, fonts_get_system_font(FONT_KEY_GOTHIC_18), bounds.size.h - STATUS_HEIGHT,
                   width, STATUS_HEIGHT, GTextAlignmentLeft);
  }
  if (!s_has_menu) {
    return;
  }

  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  int lines = count_lines(page->text);
  if (lines == 0) {
    draw_text_line(ctx, "Ничего нет", font, area.origin.y, width, ROW_HEIGHT, GTextAlignmentLeft);
    return;
  }
  int visible = area.size.h / ROW_HEIGHT;
  char line[LINE_BUFFER_SIZE];
  for (int i = 0; i < visible && scroll + i < lines; i++) {
    copy_line(page->text, scroll + i, line, sizeof(line));
    draw_text_line(ctx, line, font, area.origin.y + i * ROW_HEIGHT, width, ROW_HEIGHT, GTextAlignmentLeft);
  }
}

static void render(void) {
  layer_mark_dirty(s_page_layer);
}

static void finish_refresh(int error) {
  s_refreshing = false;
  s_error = error;
  if (s_response_timer != NULL) {
    app_timer_cancel(s_response_timer);
    s_response_timer = NULL;
  }
  render();
}

static void response_timeout(void *context) {
  s_response_timer = NULL;
  finish_refresh(ERROR_NO_PHONE);
}

static void start_waiting(void) {
  s_refreshing = true;
  if (s_response_timer != NULL) {
    app_timer_cancel(s_response_timer);
  }
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, response_timeout, NULL);
  render();
}

static void request_refresh(void) {
  if (s_refreshing) {
    return;
  }
  start_waiting();

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    finish_refresh(ERROR_NO_PHONE);
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_RequestRefresh, 1);
  if (app_message_outbox_send() != APP_MSG_OK) {
    finish_refresh(ERROR_NO_PHONE);
  }
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  Tuple *error = dict_find(iterator, MESSAGE_KEY_ErrorCode);
  if (error != NULL) {
    Tuple *api_error = dict_find(iterator, MESSAGE_KEY_ApiErrorCode);
    s_api_error = api_error != NULL ? (int)api_error->value->int32 : 0;
    finish_refresh((int)error->value->int32);
    return;
  }

  Tuple *texts[PAGE_COUNT];
  for (int i = 0; i < PAGE_COUNT; i++) {
    texts[i] = dict_find(iterator, s_message_keys[i]);
    if (texts[i] == NULL) {
      finish_refresh(ERROR_BAD_DATA);
      return;
    }
  }
  for (int i = 0; i < PAGE_COUNT; i++) {
    snprintf(s_pages[i].text, sizeof(s_pages[i].text), "%s", texts[i]->value->cstring);
    s_pages[i].scroll = 0;
  }
  s_has_menu = true;
  finish_refresh(ERROR_NONE);
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Inbox dropped: %d", (int)reason);
  finish_refresh(ERROR_BAD_DATA);
}

static void outbox_failed(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox failed: %d", (int)reason);
  finish_refresh(ERROR_NO_PHONE);
}

static void up_click(ClickRecognizerRef recognizer, void *context) {
  int scroll = clamped_scroll(s_page);
  if (scroll > 0) {
    s_pages[s_page].scroll = scroll - 1;
  } else if (s_page > 0) {
    // Back to the previous page where it was left: at its end.
    s_page--;
    s_pages[s_page].scroll = max_scroll(s_page);
  }
  render();
}

static void down_click(ClickRecognizerRef recognizer, void *context) {
  int scroll = clamped_scroll(s_page);
  if (scroll < max_scroll(s_page)) {
    s_pages[s_page].scroll = scroll + 1;
  } else if (s_page < PAGE_COUNT - 1) {
    s_page++;
    s_pages[s_page].scroll = 0;
  }
  render();
}

static void select_click(ClickRecognizerRef recognizer, void *context) {
  request_refresh();
}

static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_page_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_page_layer, draw_page);
  layer_add_child(root, s_page_layer);
}

static void window_unload(Window *window) {
  layer_destroy(s_page_layer);
}

static void set_page(int index, const char *title, GColor header, GColor header_text, uint32_t message_key) {
  s_pages[index].title = title;
  s_pages[index].header = header;
  s_pages[index].header_text = header_text;
  s_message_keys[index] = message_key;
}

static void init(void) {
  set_page(0, "Обед", GColorGreen, GColorBlack, MESSAGE_KEY_LunchText);
  set_page(1, "Перекус", GColorRed, GColorWhite, MESSAGE_KEY_SnackText);
  set_page(2, "Ужин", GColorCobaltBlue, GColorWhite, MESSAGE_KEY_DinnerText);
  set_page(3, "Завтрак", GColorChromeYellow, GColorBlack, MESSAGE_KEY_BreakfastText);

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  // All four meals arrive in one message.
  app_message_open(4096, 64);

  window_stack_push(s_window, true);

  // The phone fetches by itself on its 'ready' event, so here we only wait for the answer.
  start_waiting();
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
