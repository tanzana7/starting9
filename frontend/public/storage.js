(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicStorage(storage, logger = console) {
    function save(key, value) {
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        logger.error(`localStorageの保存に失敗しました: ${key}`, error);
        return false;
      }
    }

    function load(key) {
      try {
        const value = storage.getItem(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        logger.error(`localStorageの読み込みに失敗しました: ${key}`, error);
        return null;
      }
    }

    function remove(key) {
      try {
        storage.removeItem(key);
        return true;
      } catch (error) {
        logger.error(`localStorageの削除に失敗しました: ${key}`, error);
        return false;
      }
    }

    return { save, load, remove };
  }

  publicFrontend.createPublicStorage = createPublicStorage;
})();
